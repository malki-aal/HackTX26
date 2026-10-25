import { defineTool } from "eve/tools";
import { ToolInputs, TOOL_DESCRIPTIONS } from "../../src/agent/toolSchemas.js";
import { callRunway } from "../lib.js";

export default defineTool({
  description: TOOL_DESCRIPTIONS.readBudgetContext,
  inputSchema: ToolInputs.readBudgetContext,
  async execute(input, ctx) {
    return callRunway("readBudgetContext", ctx.session.id, input, ctx.abortSignal);
  },
});
