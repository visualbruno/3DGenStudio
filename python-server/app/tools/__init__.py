"""Standalone worker scripts run as subprocesses by app/services wrappers.

Nothing in here should be imported by the FastAPI process — workers may pull in
heavy/unsafe-in-process dependencies (bpy is not thread-safe and never unloads).
"""
