import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildSources, errorsOf, type Model } from "@appling/lang";
import { buildGraph } from "@appling/model";

// The graph of the repository's examples, which the stories on the page draw
export async function GET() {
  // the build runs in packages/landing and bundles this file, so the folder is found from there
  const folder = join(process.cwd(), "../../examples");
  const files = readdirSync(folder, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith(".appling")).map((e) => e.name);
  const workspace = await buildSources(Object.fromEntries(files.map((file) => [`file:///examples/${file}`, readFileSync(join(folder, file), "utf8")])));
  const errors = errorsOf(workspace);
  if (errors.length) throw new Error(`The examples have errors:\n${errors.join("\n")}`);
  return Response.json(buildGraph(workspace.documents.map((doc) => doc.parseResult.value as Model), workspace.services));
}
