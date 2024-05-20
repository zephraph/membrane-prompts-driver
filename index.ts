// `nodes` contain any nodes you add from the graph (dependencies)
// `root` is a reference to this program's root node
// `state` is an object that persists across program updates. Store data here.
import { root, nodes, state, handles, resolvers } from "membrane";

type Status = "not-started" | "in-progress" | "done" | "aborted";

type FlowStep = {
  id: string;
  label: string;
  kind: "input";
  status: Status;
  resolve: (value: any) => void;
  abort: (reason: any) => void;
  result: Promise<any>;
};

interface Flow {
  title: string;
  status: Status;
  steps: FlowStep[];
}

export type State = {
  flows: Record<string, Flow>;
};
state.flows ??= {};

export async function io({ title, context }) {
  /**
   * This is weird, but it's a workaround for the fact parent resolvers are
   * called again when the child resolvers are called.
   */
  state.flows[context] ??= { title, status: "not-started", steps: [] };
  return { context };
}

export async function start({ title, timeout = 30 }) {
  const context = genId();
  console.log(
    "Flow URL:",
    (await nodes.process.endpointUrl) + `/flow/${context}`
  );
  const io = root.io({ context, title });
  io.timeout({ context }).$invokeIn(timeout * 60);
  return io;
}

export const IO = {
  async inputText({ label }, { obj }) {
    verifyFlow(obj.context);
    const stepId = genId();
    let resolve;
    let abort;
    const result = new Promise((res, rej) => {
      abort = rej;
      resolve = (text) => {
        res(text);
        try {
          state.flows[obj.context].steps.find((s) => s.id === stepId)!.status =
            "done";
        } catch {}
      };
    });
    state.flows[obj.context].steps.push({
      id: stepId,
      label,
      kind: "input",
      status: "not-started",
      resolve,
      abort,
      result,
    });
    return result;
  },
  async outputText({ text }, { obj }) {
    verifyFlow(obj.context);
  },
  async timeout({ context }) {
    if (!(context in state.flows)) {
      return;
    }
    let stepAborted = false;
    state.flows[context].steps
      .filter((step) => step.status !== "done")
      .forEach((step) => {
        stepAborted = true;
        step.status = "aborted";
        step.abort("Timeout");
      });
    if (stepAborted) {
      state.flows[context].status = "aborted";
    }
  },
  async end(_, { obj }) {
    verifyFlow(obj.context);
    const flow = state.flows[obj.context];
    flow.status = "done";
  },
};

export async function test({ title, label }) {
  const io = await root.start({ title, timeout: 1 });
  const name = await io.inputText({ label: "What is your name?" });
  const result = await io.inputText({ label });
  await io.end();
  return result;
}

// Handles the program's HTTP endpoint
export const endpoint: resolvers.Root["endpoint"] = async ({
  path,
  method,
  body,
}) => {
  if (method === "POST" && path.startsWith("/flow/")) {
    if (!body) {
      return JSON.stringify({ error: "Body required", status: 400 });
    }
    const [context, stepId] = path.split("/").slice(2);
    if (context in state.flows) {
      const flow = state.flows[context];
      const step = flow.steps.find((s) => s.id === stepId);
      if (step) {
        switch (step.kind) {
          case "input": {
            const value = JSON.parse(body)?.value;
            if (!value) {
              return JSON.stringify({ error: "Value required", status: 400 });
            }
            step.resolve(value);
            return await renderFlow(context);
          }
        }
      }
    }
  }
  if (method === "GET" && path.startsWith("/flow/")) {
    const [context] = path.split("/").slice(2);
    if (context in state.flows) {
      return await renderFlow(context);
    }
    return renderRedirect("Flow not found", "/");
  }
  // Render landing page
  return renderPage(`
    <div class="box">
      <h1>Choose a flow</h1>
      <ul class="mt:8 pb:6>li">
        ${Object.keys(state.flows)
          .map(
            (context) =>
              `<li class="flex justify-content:space-between px:4 ml:8>*+*">
                <a href="/flow/${context}" class="text:underline:hover">${
                state.flows[context].title
              }</a>
                <span>${
                  { done: "️✅", aborted: "❌" }[state.flows[context].status] ??
                  ""
                }</span>
              </li>`
          )
          .join("")}
      </ul>
    </div>
  `);
};

async function renderFlow(context: string) {
  const flow = state.flows[context];
  let html = `<div class="box">`;
  for (const step of flow.steps) {
    html += await renderStep(context, step);
  }
  if (flow.status === "done") {
    html += `<p>Flow completed</p>`;
    html += `<a class="button btn btn-outline-secondary mt:6" href="${await nodes
      .process.endpointUrl}">Go Back</a>`;
  } else if (flow.status === "aborted") {
    html += `<p>Flow aborted</p>`;
    html += `<a class="button btn btn-outline-secondary mt:6" href="${await nodes
      .process.endpointUrl}">Go Back</a>`;
  } else if (flow.steps.every((step) => step.status === "done")) {
    html += await renderNextStep(context);
  }
  html += "</div>";
  return renderPage(html);
}

async function renderStep(context: string, step: FlowStep) {
  switch (step.kind) {
    case "input":
      if (step.status === "not-started") {
        step.status = "in-progress";
      }
      if (step.status === "aborted") {
        return /*html*/ `
        <p class="flex flex:col gap:1">
          <span>${step.label}</span> 
          <span class="font:bold color:#f00">Aborted</span>
        </p>`;
      }
      if (step.status === "done") {
        return /*html*/ `
        <p class="flex flex:col gap:1">
          <span>${step.label}</span> 
          <span class="font:bold">${await step.result}</span>
        </p>`;
      }
      return `
        <form hx-post="/flow/${context}/${step.id}" hx-trigger="submit" class="flex flex:col gap:6 max-w:fit">
          <label>${step.label}</label>
          <input name="value" type="text" class="border:solid|1|black">
          <button class="btn btn-outline-secondary" type="submit">Submit</button>
        </form>
      `;
  }
}

async function renderNextStep(context: string) {
  const step = state.flows[context].steps.find(
    (step) => step.status === "not-started"
  );
  if (state.flows[context].status !== "done" && !step) {
    return `<p hx-get="/flow/${context}/next" hx-trigger="load every 10s">Loading</p>`;
  } else if (!step) {
    return "";
  }
  return await renderStep(context, step);
}

function renderPage(html: string) {
  return /*html*/ `
  <html>
    <head>
      <meta charset="utf-8">
      <title>Membrane HTMX Demo</title>
      <script src="https://unpkg.com/htmx.org@1.9.12/dist/htmx.min.js"></script>
      <script src="https://unpkg.com/htmx.org@1.9.12/dist/ext/json-enc.js"></script>
      <script src="https://unpkg.com/idiomorph/dist/idiomorph-ext.min.js"></script>
      <link rel="stylesheet" href="https://www.membrane.io/light.css"></script>
      <link rel="preload" as="script" href="https://cdn.master.co/css-runtime@rc">
      <link rel="preload" as="style" href="https://cdn.master.co/normal.css@rc">
      <link rel="stylesheet" href="https://cdn.master.co/normal.css@rc">
      <script>
          window.masterCSSConfig = {
            styles: {
              box: "flex flex:col gap:8 bg:#f4f4f4 p:12|20|14 border:1|solid|#999 box-shadow:1|1|#222,2|2|#222,3|3|#222,4|4|#222,5|5|#222 background:white_input"
            },
            variables: {
                primary: '#000000'
            }
          }
      </script>
      <script src="https://cdn.master.co/css-runtime@rc"></script>
    </head>
    <body hx-ext="json-enc,morph" hx-swap="morph:innerHTML" hx-target="body">
      <main class="p:10 h:full w:full flex flex:col gap:6 justify-content:center align-items:center">
        ${html}
      </main>
    </body>
  </html>
  `;
}

function renderRedirect(message: string, url: string) {
  return renderPage(/*html*/ `
    <div class="box" hx-get="/" hx-trigger="load delay:2s" hx-replace-url="true">
      <h1>${message}</h1>
      <p>Redirecting...</p>
    </div>
  `);
}

function genId(length: number = 16): string {
  const characters =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-.~";
  const charactersLength = characters.length;
  let result = "";

  for (let i = 0; i < length; i++) {
    result += characters.charAt(
      Math.floor(
        Math.random() * (i === 0 || i === length - 1 ? 52 : charactersLength)
      )
    );
  }
  return result;
}

function verifyFlow(context?: string): context is string {
  if (!context || !(context in state.flows)) {
    throw new Error("Flow not started");
  }
  return true;
}
