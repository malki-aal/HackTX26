import { defineTool } from "eve/tools";
import { ToolInputs, TOOL_DESCRIPTIONS } from "../../src/agent/toolSchemas.js";
import { callRunway } from "../lib.js";

export default defineTool({
  description: TOOL_DESCRIPTIONS.getConfirmedRequirements,
  inputSchema: ToolInputs.getConfirmedRequirements,
  async execute(input, ctx) {
    return callRunway("getConfirmedRequirements", ctx.session.id, input, ctx.abortSignal);
  },
});
