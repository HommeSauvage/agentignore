"""hermes-agentignore — hard-block .agentignore paths at the code level.

Registers a pre_tool_call hook that vetoes any tool call touching a path
matched by .agentignore / ~/.agentsignore. No LLM involvement, no prompt,
no override: the file is the decision.
"""

import logging

from . import guard

logger = logging.getLogger(__name__)


def _on_pre_tool_call(tool_name, args, task_id, **kwargs):
    return guard.check(tool_name, args)


def register(ctx):
    ctx.register_hook("pre_tool_call", _on_pre_tool_call)
    logger.info("hermes-agentignore: pre_tool_call guard active")
