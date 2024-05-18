// `nodes` contain any nodes you add from the graph (dependencies)
// `root` is a reference to this program's root node
// `state` is an object that persists across program updates. Store data here.
import { root, nodes, state, handles, resolvers } from "membrane";

type FlowStep = {
  id: string;
  label: string;
  kind: "input";
  status: "waiting" | "done";
  resolve: (value: any) => void;
  result: Promise<any>;
};

interface Flow {
  title: string;
  steps: FlowStep[];
}

export type State = {
  flows: Record<string, Flow>;
};
state.flows ??= {};

export async function io({ title, context }) {
  state.flows[context] = { title, steps: [] };
  return { context };
}

export async function start({ title }) {
  const context = genId();
  console.log(
    "Flow URL:",
    (await nodes.process.endpointUrl) + `/flow/${context}`
  );
  return root.io({ context, title });
}

export const IO = {
  async input({ label }, { obj }) {
    if (!obj?.context || !(obj.context in state.flows)) {
      throw new Error("Flow not started");
    }
    let resolve;
    const result = new Promise((r) => {
      resolve = r;
    });
    state.flows[obj.context].steps.push({
      id: genId(),
      label,
      kind: "input",
      status: "waiting",
      resolve,
      result,
    });
    return result;
  },
};

export async function test({ title, label }) {
  const io = await root.start({ title });
  const name = await io.input({ label: "What is your name?" });
  console.log(name);
  return await io.input({ label });
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
            step.status = "done";
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
    return JSON.stringify({ error: "Flow not found", status: 404 });
  }
  return render(`
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
                <span class="font:bold">${
                  state.flows[context].steps.every(
                    (step) => step.status === "done"
                  )
                    ? "Done"
                    : ""
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
  let html = "";
  for (const step of flow.steps) {
    html += await renderStep(context, step);
  }
  if (flow.steps[flow.steps.length - 1].status === "done") {
    html += `<p>Flow completed</p>`;
    html += `<a class="button btn btn-outline-secondary mt:6" href="${await nodes
      .process.endpointUrl}">Go Back</a>`;
  }
  return render(html);
}

async function renderStep(context: string, step: FlowStep) {
  switch (step.kind) {
    case "input":
      if (step.status === "done") {
        return `<p>${step.label}: ${await step.result}</p>`;
      }
      return `
        <form hx-post="/flow/${context}/${step.id}" hx-trigger="submit" hx-swap="outerHTML" hx-ext="json-enc" class="flex flex:col gap:6 max-w:fit">
          <label>${step.label}</label>
          <input name="value" type="text" class="border:solid|1|black">
          <button class="btn btn-outline-secondary" type="submit">Submit</button>
        </form>
      `;
  }
}

function render(html: string) {
  return /*html*/ `
  <html>
    <head>
      <meta charset="utf-8">
      <title>Membrane HTMX Demo</title>
      <script src="https://unpkg.com/htmx.org@1.9.12/dist/htmx.min.js"></script>
      <script src="https://unpkg.com/htmx.org@1.9.12/dist/ext/json-enc.js"></script>
      <link rel="stylesheet" href="https://www.membrane.io/light.css"></script>
      <link rel="preload" as="script" href="https://cdn.master.co/css-runtime@rc">
      <link rel="preload" as="style" href="https://cdn.master.co/normal.css@rc">
      <link rel="stylesheet" href="https://cdn.master.co/normal.css@rc">
      <script>
          window.masterCSSConfig = {
            styles: {
              box: "flex flex:col gap:8 bg:#f4f4f4 p:12|20|14 border:1|solid|#999 box-shadow:1|1|#222,2|2|#222,3|3|#222,4|4|#222,5|5|#222"
            },
            variables: {
                primary: '#000000'
            }
          }
      </script>
      <script src="https://cdn.master.co/css-runtime@rc"></script>
    </head>
    <body>
      <main class="p:10 h:full w:full flex flex:col gap:6 justify-content:center align-items:center">
        ${html}
      </main>
    </body>
  </html>
  `;
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
