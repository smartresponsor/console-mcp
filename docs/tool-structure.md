# Console MCP Tool Structure

This document defines the preferred internal layout for the future readable tool tree. It is a migration target, not a requirement to move every file in one patch.

## File naming

Tool implementation files should eventually use this form:

```text
console-<risk>-<domain>-<technology>-<subject>-<action>-tool.ts
```

Use `read` in file names, not `read_`. The underscore padding is only for public MCP tool names.

Examples:

```text
console-read-repo-git-diff-tool.ts
console-write-repo-git-commit-signed-tool.ts
console-read-framework-symfony-route-list-tool.ts
console-write-framework-symfony-cache-clear-tool.ts
console-read-framework-doctrine-migration-status-tool.ts
console-read-database-sql-postgres-query-tool.ts
console-read-ai-gateway-ask-tool.ts
```

## Preferred nested tree

```text
src/tool/
  read/
    system/console/
    repo/workspace/
    repo/context/
    repo/file/
    repo/text/
    repo/git/
    package/composer/
    package/npm/
    package/php/
    framework/symfony/
    framework/doctrine/
    database/sql/postgres/
    database/sql/mysql/
    database/sql/sqlite/
    runtime/php/
    runtime/mobile_edge/
    runtime/console_mcp/
    http/loopback/
    http/localhost/
    browser/edge/
    browser/chromium/
    browser/playwright/
    ai/gateway/
    release/rc/
    ads/google_editor/
  write/
    repo/file/
    repo/patch/
    repo/git/
    package/composer/
    package/npm/
    framework/symfony/
    framework/doctrine/
    runtime/php/
    runtime/mobile_edge/
    runtime/console_mcp/
    browser/edge/
    browser/playwright/
    release/rc/
```

## Alternative short tree

The short tree is acceptable for early migration if technology tokens stay visible:

```text
src/tool/read-repo-git/
src/tool/write-repo-git/
src/tool/read-package-composer/
src/tool/write-package-composer/
src/tool/read-framework-symfony/
src/tool/write-framework-symfony/
src/tool/read-framework-doctrine/
src/tool/write-framework-doctrine/
src/tool/read-database-sql-postgres/
src/tool/read-ai-gateway/
```

## Policy files

Policy files should expose domain and technology in their names:

```text
