# Todo Manager

A command-line todo list application built with Python.

## Requirements

- Python 3.13+

## Project Structure

```
todo_manager/
├── main.py          # Entry point
├── models.py        # Task and TodoList data classes
├── manager.py       # Task operations (add, complete, filter, stats)
├── requirements.txt # Dependencies (none required)
└── README.md
```

## How to Run

```bash
cd todo_manager
python3 main.py
```

The application will create sample tasks and display:
- A summary of the todo list
- A formatted report with stats
- High priority and bug-tagged tasks
- Any overdue tasks
