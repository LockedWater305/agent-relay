// Test-only entry point. Do not add this file to the packaged desktop app.
import { app } from "electron";
import { configureDesktopTestApp } from "./desktop-test-harness.mjs";

// userData must be set before main.mjs acquires the single-instance lock.
// sessionData must be set before Electron creates its default session.
configureDesktopTestApp(app);
await import("../../desktop/main.mjs");
