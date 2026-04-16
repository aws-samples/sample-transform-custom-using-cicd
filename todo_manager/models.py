from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime


@dataclass
class Task:
    title: str
    priority: str  # "low", "medium", "high"
    deadline: str | None = None
    completed: bool = False
    tags: list[str] = field(default_factory=list)
    metadata: dict[str, str] | None = None

    def to_dict(self) -> dict[str, str | bool | list[str]]:
        result: dict[str, str | bool | list[str]] = {}
        result["title"] = self.title
        result["priority"] = self.priority
        result["deadline"] = self.deadline if self.deadline else "N/A"
        result["completed"] = self.completed
        result["tags"] = self.tags
        return result


@dataclass
class TodoList:
    name: str
    tasks: list[Task] = field(default_factory=list)
    created_at: str = field(default_factory=lambda: datetime.now().strftime("%Y-%m-%d %H:%M:%S"))

    def summary(self) -> dict[str, int | str]:
        result: dict[str, int | str] = {}
        result["list_name"] = self.name
        result["total_tasks"] = len(self.tasks)
        result["completed"] = len([t for t in self.tasks if t.completed])
        result["pending"] = len([t for t in self.tasks if not t.completed])
        return result
