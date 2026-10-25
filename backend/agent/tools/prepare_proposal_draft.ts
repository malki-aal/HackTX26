import { defineTool } from "eve/tools";
import { ToolInputs, TOOL_DESCRIPTIONS } from "../../src/agent/toolSchemas.js";
import { callRunway } from "../lib.js";

export default defineTool({
  description: TOOL_DESCRIPTIONS.prepareProposalDraft,
  inputSchema: ToolInputs.prepareProposalDraft,
  async execute(input, ctx) {
    return callRunway("prepareProposalDraft", ctx.session.id, input, ctx.abortSignal);
  },
});
