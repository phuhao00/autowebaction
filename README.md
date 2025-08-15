# MCP 网页自动化测试服务

基于 Playwright 的 MCP 工具服务，提供浏览器启动、页面访问、点击、输入、断言、截图、页面执行脚本等能力，用于编排自动化网页测试。

## 功能列表（Tools）

- `browser_open`：启动 Chromium（可选无头）
- `browser_close`：关闭浏览器
- `page_goto`：访问 URL（可设置 `waitUntil`）
- `page_click`：点击 CSS 选择器
- `page_type`：在输入框逐字输入（可清空后输入、设置延迟）
- `page_fill`：在输入框填充文本（直接替换）
- `page_assert`：断言元素可见或文本包含
- `page_screenshot`：页面截图为 base64（png）
- `page_eval`：在页面执行 JS 表达式，返回序列化结果
- `page_wait_for`：等待元素到指定状态
- `page_title_get` / `page_url_get` / `page_text_get` / `page_attribute_get`
- `page_viewport`：设置视口
- `page_new` / `page_switch` / `page_close`：多标签页
- `test_plan_run`：按顺序执行测试计划中的多步工具调用（可选遇错继续）
- `test_plan_run_file`：从 JSON 文件加载计划/套件
- `test_suite_run`：支持 setup/tests/teardown、重试、junit 输出、自动开关浏览器
- `tracing_start` / `tracing_stop`：收集 Playwright tracing

## 环境要求

- Node.js >= 18
- Windows / macOS / Linux

## 安装

```bash
cd D:/autotest/autotest
npm install
npm run playwright:install
```

## 开发运行

```bash
# 在任意目录执行
D:\autotest\start-dev.cmd
```

服务将作为 MCP 进程通讯（stdio）。开发时可直接运行观察日志。

## 构建与启动

```bash
# 在任意目录执行
D:\autotest\start-prod.cmd
```

## 在 MCP 客户端配置

以 Claude Desktop（或任意 MCP 客户端）为例，在其配置中增加：

```json
{
  "mcpServers": {
    "mcp-web-autotest": {
      "command": "node",
      "args": ["D:/autotest/autotest/dist/server.js"],
      "env": {
        "NODE_ENV": "production"
      }
    }
  }
}
```

开发模式可直接用 ts-node/tsx：

```json
{
  "mcpServers": {
    "mcp-web-autotest": {
      "command": "npx",
      "args": ["tsx", "D:/autotest/autotest/src/server.ts"]
    }
  }
}
```

## 使用示例

1) 启动浏览器

```json
{"name":"browser_open","arguments":{"headless":false}}
```

2) 访问页面

```json
{"name":"page_goto","arguments":{"url":"https://example.com","waitUntil":"domcontentloaded"}}
```

3) 点击 + 输入 + 断言

```json
{"name":"page_click","arguments":{"selector":"#login"}}
{"name":"page_fill","arguments":{"selector":"#username","value":"tester"}}
{"name":"page_type","arguments":{"selector":"#password","text":"secret","clear":true}}
{"name":"page_click","arguments":{"selector":"button[type=submit]"}}
{"name":"page_assert","arguments":{"kind":"visible","selector":".dashboard"}}
```

4) 截图

```json
{"name":"page_screenshot","arguments":{"fullPage":true}}
```

5) 页面执行表达式

```json
{"name":"page_eval","arguments":{"expression":"document.title"}}
```

6) 执行测试计划

```json
{
  "name": "test_plan_run",
  "arguments": {
    "continueOnError": false,
    "steps": [
      { "name": "browser_open", "arguments": { "headless": true } },
      { "name": "page_goto", "arguments": { "url": "https://example.com" } },
      { "name": "page_assert", "arguments": { "kind": "visible", "selector": "body" } },
      { "name": "browser_close" }
    ]
  }
}
```

7) 执行测试套件并生成 JUnit

```json
{
  "name": "test_suite_run",
  "arguments": {
    "autoBrowser": true,
    "headless": true,
    "retries": 1,
    "continueOnError": false,
    "junit": true,
    "junitPath": "D:/autotest/report.xml",
    "setup": [
      { "name": "page_viewport", "arguments": { "width": 1366, "height": 768 } }
    ],
    "tests": [
      {
        "name": "Example",
        "steps": [
          { "name": "page_goto", "arguments": { "url": "https://example.com" } },
          { "name": "page_assert", "arguments": { "kind": "title_contains", "selector": "html", "text": "Example" } }
        ]
      }
    ],
    "teardown": [
      { "name": "browser_close" }
    ]
  }
}
```

## 注意事项

- 第一次使用需执行 `npm run playwright:install` 安装浏览器。
- 运行多个测试时，建议复用同一浏览器进程，最后调用 `browser_close` 释放资源。
- 如需多标签/多上下文，可扩展服务在内存中管理多个 `Page` 实例并在工具参数中传递 `pageId`。

## 许可

MIT
