from __future__ import annotations

from datetime import datetime
from models import Task, TodoList


def add_task(todo_list: TodoList, task: Task) -> TodoList:
    todo_list.tasks.append(task)
    return todo_list


def complete_task(todo_list: TodoList, title: str) -> Task | None:
    for task in todo_list.tasks:
        if task.title == title:
            task.completed = True
            return task
    return None


def filter_by_priority(
    tasks: list[Task], priority: str
) -> list[Task]:
    filtered: list[Task] = []
    for t in tasks:
        if t.priority == priority:
            filtered.append(t)
    return filtered


def filter_by_tag(
    tasks: list[Task], tag: str
) -> list[Task]:
    filtered: list[Task] = []
    for t in tasks:
        if tag in t.tags:
            filtered.append(t)
    return filtered


def get_overdue_tasks(tasks: list[Task]) -> list[Task]:
    now = datetime.now().strftime("%Y-%m-%d")
    overdue: list[Task] = []
    for t in tasks:
        if t.deadline is not None and t.deadline < now and not t.completed:
            overdue.append(t)
    return overdue


def get_stats(todo_list: TodoList) -> dict[str, int]:
    stats: dict[str, int] = {}
    stats["total"] = len(todo_list.tasks)
    stats["completed"] = len([t for t in todo_list.tasks if t.completed])
    stats["pending"] = stats["total"] - stats["completed"]
    priority_counts: dict[str, int] = {}
    for t in todo_list.tasks:
        if t.priority in priority_counts:
            priority_counts[t.priority] = priority_counts[t.priority] + 1
        else:
            priority_counts[t.priority] = 1
    stats.update(priority_counts)
    return stats


def format_report(todo_list: TodoList, stats: dict[str, int]) -> str:
    lines: list[str] = []
    lines.append("=" * 50)
    lines.append(f"Todo List: {todo_list.name}")
    lines.append(f"Created: {todo_list.created_at}")
    lines.append("-" * 50)

    for key, val in stats.items():
        lines.append(f"  {key}: {val}")

    lines.append("-" * 50)
    for task in todo_list.tasks:
        status = "[x]" if task.completed else "[ ]"
        deadline = task.deadline if task.deadline else "none"
        line = f"  {status} {task.title} (priority: {task.priority}, deadline: {deadline})"
        lines.append(line)
        if task.tags:
            lines.append(f"      tags: {', '.join(task.tags)}")

    lines.append("=" * 50)
    return "\n".join(lines)
