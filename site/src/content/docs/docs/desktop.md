---
title: Desktop app
description: tablewalk as a desktop app for macOS, Windows and Linux. The same browser in its own window, with no Node.js to install.
---

The desktop app is tablewalk in its own window, for people who would rather not install Node.js.

Download it from the [releases page](https://github.com/rbaljinder/tablewalk/releases): a `.dmg` for macOS, an installer for Windows, and an AppImage for Linux.

## Opening a database

**File ▸ Open Database…** (`⌘O`) opens a SQLite file. When it starts, the app opens, in order:

1. a database named on the command line,
2. the database you had open last,
3. a `tablewalk.json` it finds, as the command line would,
4. and otherwise the welcome page, where you can open the sample database or connect one.

A PostgreSQL database is connected from the page, or named in a `tablewalk.json`.

**File ▸ Open in Browser** opens the same session in your usual browser.

## What is different from the command line

- The server listens on a free port chosen at launch, on loopback only, so it never collides with a `npx tablewalk` you already have running.
- Closing the window quits the app, on macOS too, because it holds a database open.
- Only one copy runs at a time; opening it again brings the window forward.
- Everything else, including [read-only by default](/docs/writing/), is the same.

## Signing

The macOS app is signed and notarized, so it opens normally. The Windows app is not signed yet, so its first open shows a SmartScreen warning: choose **More info**, then **Run anyway**. `npx tablewalk` and the container image need neither.
