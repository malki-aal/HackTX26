import { defineTool } from "eve/tools";
import { ToolInputs, TOOL_DESCRIPTIONS } from "../../src/agent/toolSchemas.js";
import { callRunway } from "../lib.js";

export default defineTool({
  description: TOOL_DESCRIPTIONS.searchProducts,
  inputSchema: ToolInputs.searchProducts,
  async execute(input, ctx) {
    return callRunway("searchProducts", ctx.session.id, input, ctx.abortSignal);
  },
});
