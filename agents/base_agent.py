# agents/base_agent.py
from abc import ABC, abstractmethod
from typing import Dict, Any, Optional, List
from dataclasses import dataclass, field
from datetime import datetime

@dataclass
class AgentResult:
    """Result of an agent's execution."""
    task_id: str
    task_type: str
    architecture: str
    success: bool
    exploit_code: Optional[str] = None
    execution_time: float = 0.0
    token_count: int = 0
    error_message: Optional[str] = None
    steps: List[str] = field(default_factory=list)
    timestamp: datetime = field(default_factory=datetime.now)

    def __repr__(self):
        return (
            f"<AgentResult {self.task_id} | "
            f"success={self.success} | time={self.execution_time:.2f}s>"
        )

class BaseAgent(ABC):
    """Abstract base class for all agent architectures."""
    
    def __init__(self, config: Dict[str, Any], llm_client: Any):
        self.config = config
        self.llm_client = llm_client
        
    @abstractmethod
    async def generate_exploit(self, task: Dict[str, Any]) -> AgentResult:
        """Generate exploit for given task."""
        pass
    
    @abstractmethod
    def get_architecture_name(self) -> str:
        """Return architecture identifier."""
        pass

    def is_general_reasoning_task(self, task: Dict[str, Any]) -> bool:
        """Detect reasoning prompts that are explanatory rather than exploit-focused."""
        if task.get("task_type") != "reasoning":
            return False

        description = str(task.get("description", "") or "").strip().lower()
        context = str(task.get("context", "") or "").strip().lower()
        code_snippet = str(task.get("code_snippet", "") or "").strip().lower()

        question_starters = (
            "what ",
            "how ",
            "why ",
            "when ",
            "which ",
            "who ",
            "explain ",
            "describe ",
            "compare ",
            "tell me ",
        )
        explicit_code_request_terms = [
            "write code",
            "generate code",
            "python exploit",
            "exploit script",
            "payload",
            "shellcode",
            "proof of concept",
            "poc",
            "working exploit",
            "buffer overflow",
            "reverse shell",
            "rce",
            "return only code",
            "generate exploit",
        ]

        combined_text = " ".join(part for part in (description, context, code_snippet) if part)
        looks_like_plain_question = (
            "?" in description
            or description.startswith(question_starters)
            or description.endswith("?")
        )
        asks_for_code = any(term in combined_text for term in explicit_code_request_terms)

        if looks_like_plain_question and not asks_for_code:
            return True

        if code_snippet and any(token in code_snippet for token in ("def ", "class ", "{", "}", "strcpy(", "memcpy(")):
            return False

        return not asks_for_code

    def validate_output(self, task: Dict[str, Any], output: Optional[str]) -> bool:
        """Use syntax validation for code tasks and non-empty output for general answers."""
        if not output or not output.strip():
            return False
        if self.is_general_reasoning_task(task):
            return True
        return self._validate_syntax(output)

    def _validate_syntax(self, code: str) -> bool:
        """Basic syntax validation for code-centric tasks."""
        try:
            compile(code, "<string>", "exec")
            return True
        except SyntaxError:
            return False
