import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError
} from "@modelcontextprotocol/sdk/types.js";
import { chromium, Browser, Page } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

type BrowserContextState = {
  browser: Browser | null;
  page: Page | null;
  pages: Map<string, Page>;
  currentPageId: string | null;
};

const state: BrowserContextState = {
  browser: null,
  page: null,
  pages: new Map<string, Page>(),
  currentPageId: null
};

let pageIdCounter = 1;
function nextPageId(): string {
  const id = `page${pageIdCounter++}`;
  return id;
}

const server = new Server({
  name: "mcp-web-autotest",
  version: "0.1.0"
});

// 声明支持 tools 能力（必须在连接前注册）
server.registerCapabilities({ tools: {} });

function getEnvBoolean(name: string, defaultValue: boolean): boolean {
  const v = process.env[name];
  if (typeof v !== "string") return defaultValue;
  const n = v.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(n)) return true;
  if (["0", "false", "no", "n", "off"].includes(n)) return false;
  return defaultValue;
}

// 工具定义
const tools = {
  "browser_open": {
    name: "browser_open",
    description: "启动 Chromium 浏览器，可选择无头模式",
    inputSchema: z.object({
      headless: z.boolean().optional(),
      disableExtensions: z.boolean().optional(),
      args: z.array(z.string()).optional(),
      lang: z.string().optional()
    })
  },
  "browser_close": {
    name: "browser_close",
    description: "关闭浏览器",
    inputSchema: z.object({})
  },
  "page_goto": {
    name: "page_goto",
    description: "访问指定 URL 并等待加载",
    inputSchema: z.object({ url: z.string().url(), waitUntil: z.enum(["load", "domcontentloaded", "networkidle", "commit"]).optional() })
  },
  "page_click": {
    name: "page_click",
    description: "点击选择器对应的元素",
    inputSchema: z.object({ selector: z.string(), timeoutMs: z.number().optional() })
  },
  "page_type": {
    name: "page_type",
    description: "在输入框选择器内输入文本（清空后输入）",
    inputSchema: z.object({ selector: z.string(), text: z.string(), delayMs: z.number().optional(), clear: z.boolean().optional() })
  },
  "page_fill": {
    name: "page_fill",
    description: "在输入框选择器内填充文本（替换现有内容）",
    inputSchema: z.object({ selector: z.string(), value: z.string() })
  },
  "page_assert": {
    name: "page_assert",
    description: "断言：可见/隐藏/文本包含/计数/标题/URL/属性/值",
    inputSchema: z.object({
      kind: z.enum(["visible", "hidden", "text_contains", "count_is", "title_is", "title_contains", "url_contains", "attribute_is", "value_is"]).default("visible"),
      selector: z.string(),
      text: z.string().optional(),
      count: z.number().optional(),
      name: z.string().optional(),
      timeoutMs: z.number().optional()
    })
  },
  "page_screenshot": {
    name: "page_screenshot",
    description: "页面截图为 base64",
    inputSchema: z.object({ fullPage: z.boolean().optional() })
  },
  "page_eval": {
    name: "page_eval",
    description: "在页面执行 JS 表达式并返回结果（序列化）",
    inputSchema: z.object({ expression: z.string() })
	},
  "page_wait_for": {
    name: "page_wait_for",
    description: "等待选择器达到指定状态",
    inputSchema: z.object({ selector: z.string(), state: z.enum(["visible", "hidden", "attached", "detached"]).optional(), timeoutMs: z.number().optional() })
  },
  "page_title_get": {
    name: "page_title_get",
    description: "获取页面标题",
    inputSchema: z.object({})
  },
  "page_url_get": {
    name: "page_url_get",
    description: "获取页面 URL",
    inputSchema: z.object({})
  },
  "page_text_get": {
    name: "page_text_get",
    description: "获取选择器的 textContent",
    inputSchema: z.object({ selector: z.string(), timeoutMs: z.number().optional() })
  },
  "page_attribute_get": {
    name: "page_attribute_get",
    description: "获取选择器的属性值",
    inputSchema: z.object({ selector: z.string(), name: z.string(), timeoutMs: z.number().optional() })
  },
  "page_viewport": {
    name: "page_viewport",
    description: "设置视口大小",
    inputSchema: z.object({ width: z.number(), height: z.number(), deviceScaleFactor: z.number().optional() })
  },
  "page_new": {
    name: "page_new",
    description: "新开标签页并返回 pageId",
    inputSchema: z.object({ id: z.string().optional() })
  },
  "page_switch": {
    name: "page_switch",
    description: "切换当前活动标签页",
    inputSchema: z.object({ id: z.string() })
  },
  "page_close": {
    name: "page_close",
    description: "关闭标签页",
    inputSchema: z.object({ id: z.string().optional() })
  },
  "tracing_start": {
    name: "tracing_start",
    description: "开始 Playwright tracing",
    inputSchema: z.object({ screenshots: z.boolean().optional(), snapshots: z.boolean().optional(), sources: z.boolean().optional() })
  },
  "tracing_stop": {
    name: "tracing_stop",
    description: "停止 tracing 并导出 zip（返回 base64 或保存到路径）",
    inputSchema: z.object({ path: z.string().optional() })
  },
	"test_plan_run": {
		name: "test_plan_run",
		description: "执行测试计划：按顺序调用多个工具步骤",
		inputSchema: z.object({
			steps: z.array(
				z.object({
					name: z.string(),
					arguments: z.record(z.any()).optional()
				})
			),
			continueOnError: z.boolean().optional()
		})
  },
  "test_plan_run_file": {
    name: "test_plan_run_file",
    description: "从 JSON 文件加载并执行测试计划或测试套件",
    inputSchema: z.object({ path: z.string() })
  },
  "test_suite_run": {
    name: "test_suite_run",
    description: "执行测试套件（可含 setup/tests/teardown），支持 JUnit 报告",
    inputSchema: z.object({
      setup: z.array(z.object({ name: z.string(), arguments: z.record(z.any()).optional() })).optional(),
      tests: z.array(z.object({ name: z.string(), steps: z.array(z.object({ name: z.string(), arguments: z.record(z.any()).optional() })) })),
      teardown: z.array(z.object({ name: z.string(), arguments: z.record(z.any()).optional() })).optional(),
      continueOnError: z.boolean().optional(),
      retries: z.number().optional(),
      junit: z.boolean().optional(),
      junitPath: z.string().optional(),
      autoBrowser: z.boolean().optional(),
      headless: z.boolean().optional(),
      artifactsDir: z.string().optional(),
      onFailureScreenshot: z.boolean().optional(),
      traceOnFailure: z.boolean().optional()
    })
  }
} as const;

// 每个工具的执行实现
const handlers: Record<string, (input: any) => Promise<{ content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> }>> = {
	async browser_open(input) {
		if (state.browser) {
			await state.browser.close();
		}
		// const headless = input.headless ?? getEnvBoolean("MCP_HEADLESS", true);
    const headless =false
		const launchArgs: string[] = [];
		if (input.disableExtensions ?? true) {
			launchArgs.push("--disable-extensions", "--disable-component-extensions-with-background-pages", "--disable-features=ExtensionsToolbarMenu");
		}
		if (input.lang) {
			launchArgs.push(`--lang=${input.lang}`);
		}
		if (Array.isArray(input.args) && input.args.length) {
			launchArgs.push(...input.args);
		}
		state.browser = await chromium.launch({ headless, args: launchArgs });
		const context = await state.browser.newContext();
		state.page = await context.newPage();
		state.pages.clear();
		const defaultId = nextPageId();
		state.pages.set(defaultId, state.page);
		state.currentPageId = defaultId;
		return { content: [{ type: "text", text: `browser opened (headless=${headless})` }] };
	},
	async browser_close() {
		if (state.browser) {
			await state.browser.close();
			state.browser = null;
			state.page = null;
      state.pages.clear();
      state.currentPageId = null;
		}
		return { content: [{ type: "text", text: "browser closed" }] };
	},
	async page_goto(input) {
		const page = ensurePage();
		await page.goto(input.url, { waitUntil: input.waitUntil ?? "domcontentloaded" });
		return { content: [{ type: "text", text: `navigated: ${input.url}` }] };
	},
	async page_click(input) {
		const page = ensurePage();
		await page.click(input.selector, { timeout: input.timeoutMs ?? 15000 });
		return { content: [{ type: "text", text: `clicked: ${input.selector}` }] };
	},
  async page_new(input) {
    const page = ensurePage();
    const context = page.context();
    const newPage = await context.newPage();
    const id = input.id ?? nextPageId();
    state.pages.set(id, newPage);
    state.page = newPage;
    state.currentPageId = id;
    return { content: [{ type: "text", text: id }] };
  },
  async page_switch(input) {
    const target = state.pages.get(input.id);
    if (!target) {
      throw new McpError(ErrorCode.InvalidRequest, `未知 pageId: ${input.id}`);
    }
    state.page = target;
    state.currentPageId = input.id;
    return { content: [{ type: "text", text: `switched to ${input.id}` }] };
  },
  async page_close(input) {
    const id = input.id ?? state.currentPageId;
    if (!id) {
      throw new McpError(ErrorCode.InvalidRequest, "没有可关闭的 pageId");
    }
    const p = state.pages.get(id);
    if (!p) {
      throw new McpError(ErrorCode.InvalidRequest, `未知 pageId: ${id}`);
    }
    await p.close();
    state.pages.delete(id);
    if (state.currentPageId === id) {
      const next = state.pages.keys().next().value as string | undefined;
      state.currentPageId = next ?? null;
      state.page = next ? state.pages.get(next)! : null;
    }
    return { content: [{ type: "text", text: `closed ${id}` }] };
  },
	async page_type(input) {
		const page = ensurePage();
		if (input.clear) {
			await page.fill(input.selector, "");
		}
		await page.type(input.selector, input.text, { delay: input.delayMs });
		return { content: [{ type: "text", text: `typed into ${input.selector}` }] };
	},
	async page_fill(input) {
		const page = ensurePage();
		await page.fill(input.selector, input.value);
		return { content: [{ type: "text", text: `filled ${input.selector}` }] };
	},
  async page_viewport(input) {
    const page = ensurePage();
    await page.setViewportSize({ width: input.width, height: input.height });
    return { content: [{ type: "text", text: `viewport ${input.width}x${input.height}` }] };
  },
  async page_assert(input) {
		const page = ensurePage();
    if (input.kind === "visible") {
      await page.waitForSelector(input.selector, { state: "visible", timeout: input.timeoutMs ?? 15000 });
      return { content: [{ type: "text", text: `assert visible: ${input.selector}` }] };
    }
    if (input.kind === "hidden") {
      await page.waitForSelector(input.selector, { state: "hidden", timeout: input.timeoutMs ?? 15000 });
      return { content: [{ type: "text", text: `assert hidden: ${input.selector}` }] };
    }
    if (input.kind === "text_contains") {
      if (!input.text) {
        throw new McpError(ErrorCode.InvalidParams, "text_contains 需要提供 text 参数");
      }
      await page.waitForFunction(
        ([selector, expected]) => {
          const el = document.querySelector(selector as string);
          return !!el && el.textContent?.includes(expected as string);
        },
        [input.selector, input.text],
        { timeout: input.timeoutMs ?? 15000 }
      );
      return { content: [{ type: "text", text: `assert text contains on ${input.selector}` }] };
    }
    if (input.kind === "count_is") {
      const count = await page.locator(input.selector).count();
      if (count !== input.count) {
        throw new McpError(ErrorCode.InvalidRequest, `count ${count} !== ${input.count}`);
      }
      return { content: [{ type: "text", text: `assert count ${count}` }] };
    }
    if (input.kind === "title_is") {
      const title = await page.title();
      if (title !== input.text) {
        throw new McpError(ErrorCode.InvalidRequest, `title '${title}' !== '${input.text}'`);
      }
      return { content: [{ type: "text", text: `assert title is '${input.text}'` }] };
    }
    if (input.kind === "title_contains") {
      const title = await page.title();
      if (!input.text || !title.includes(input.text)) {
        throw new McpError(ErrorCode.InvalidRequest, `title '${title}' not contains '${input.text}'`);
      }
      return { content: [{ type: "text", text: `assert title contains '${input.text}'` }] };
    }
    if (input.kind === "url_contains") {
      const url = page.url();
      if (!input.text || !url.includes(input.text)) {
        throw new McpError(ErrorCode.InvalidRequest, `url '${url}' not contains '${input.text}'`);
      }
      return { content: [{ type: "text", text: `assert url contains '${input.text}'` }] };
    }
    if (input.kind === "attribute_is") {
      const el = page.locator(input.selector).first();
      await el.waitFor({ state: "attached", timeout: input.timeoutMs ?? 15000 });
      const val = await el.getAttribute(input.name!);
      if (val !== input.text) {
        throw new McpError(ErrorCode.InvalidRequest, `attribute '${input.name}' = '${val}' !== '${input.text}'`);
      }
      return { content: [{ type: "text", text: `assert attribute '${input.name}' is '${input.text}'` }] };
    }
    if (input.kind === "value_is") {
      const el = page.locator(input.selector).first();
      await el.waitFor({ state: "attached", timeout: input.timeoutMs ?? 15000 });
      const val = await el.inputValue();
      if (val !== input.text) {
        throw new McpError(ErrorCode.InvalidRequest, `value '${val}' !== '${input.text}'`);
      }
      return { content: [{ type: "text", text: `assert value is '${input.text}'` }] };
    }
    return { content: [{ type: "text", text: "assert noop" }] };
	},
	async page_screenshot(input) {
		const page = ensurePage();
		const buffer = await page.screenshot({ fullPage: input.fullPage ?? false, type: "png" });
		const b64 = buffer.toString("base64");
		return { content: [{ type: "image", data: b64, mimeType: "image/png" }] } as any;
	},
	async page_eval(input) {
		const page = ensurePage();
		const result = await page.evaluate((expression) => {
			// eslint-disable-next-line no-new-func
			return Function(`"use strict"; return (${expression});`)();
		}, input.expression);
		return { content: [{ type: "text", text: JSON.stringify(result) }] };
	},
  async tracing_start(input) {
    const page = ensurePage();
    await page.context().tracing.start({ screenshots: input.screenshots ?? true, snapshots: input.snapshots ?? true, sources: input.sources ?? false });
    return { content: [{ type: "text", text: "tracing started" }] };
  },
  async tracing_stop(input) {
    const page = ensurePage();
    if (input.path) {
      await page.context().tracing.stop({ path: input.path });
      return { content: [{ type: "text", text: `trace saved: ${input.path}` }] };
    }
    const tmp = `trace_${Date.now()}.zip`;
    await page.context().tracing.stop({ path: tmp });
    const buf = await fs.readFile(tmp);
    const b64 = buf.toString("base64");
    return { content: [{ type: "text", text: b64 }] };
  },
  async page_wait_for(input) {
    const page = ensurePage();
    await page.waitForSelector(input.selector, { state: (input.state as any) ?? "visible", timeout: input.timeoutMs ?? 15000 });
    return { content: [{ type: "text", text: `waited for ${input.selector}` }] };
  },
  async page_title_get() {
    const page = ensurePage();
    const title = await page.title();
    return { content: [{ type: "text", text: title }] };
  },
  async page_url_get() {
    const page = ensurePage();
    const url = page.url();
    return { content: [{ type: "text", text: url }] };
  },
  async page_text_get(input) {
    const page = ensurePage();
    await page.waitForSelector(input.selector, { timeout: input.timeoutMs ?? 15000 });
    const text = await page.locator(input.selector).first().textContent();
    return { content: [{ type: "text", text: text ?? "" }] };
  },
  async page_attribute_get(input) {
    const page = ensurePage();
    await page.waitForSelector(input.selector, { timeout: input.timeoutMs ?? 15000 });
    const val = await page.locator(input.selector).first().getAttribute(input.name);
    return { content: [{ type: "text", text: val ?? "" }] };
  },
  async test_plan_run_file(input) {
    const raw = await fs.readFile(input.path, "utf-8");
    const data = JSON.parse(raw);
    if (Array.isArray(data?.steps)) {
      return handlers.test_plan_run(data);
    }
    return handlers.test_suite_run(data);
  },
  async test_suite_run(input) {
    const results: any = { setup: [], tests: [], teardown: [], junit: null };
    const ensureDir = async (dir: string) => { try { await fs.mkdir(dir, { recursive: true }); } catch { /* noop */ } };
    const runSteps = async (steps: any[], phase: "setup" | "teardown" | "test") => {
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        try {
          const tool = (tools as any)[step.name];
          if (!tool) throw new Error("未知工具");
          const args = tool.inputSchema.parse(step.arguments ?? {});
          await handlers[step.name](args);
          (phase === "test" ? results.tests : (phase === "setup" ? results.setup : results.teardown)).push({ name: step.name, ok: true });
        } catch (e: any) {
          (phase === "test" ? results.tests : (phase === "setup" ? results.setup : results.teardown)).push({ name: step.name, ok: false, message: e?.message ?? String(e) });
          if (!input.continueOnError) throw e;
        }
      }
    };
    const shouldAutoBrowser = input.autoBrowser ?? true;
    if (shouldAutoBrowser && !state.browser) {
      await handlers.browser_open({ headless: input.headless });
    }
    if (input.setup?.length) await runSteps(input.setup, "setup");
    const artifactsDir = input.artifactsDir ?? path.join(process.cwd(), `artifacts_${Date.now()}`);
    if (input.onFailureScreenshot || input.traceOnFailure || input.junitPath || input.artifactsDir) {
      await ensureDir(artifactsDir);
    }
    for (const test of input.tests) {
      let attempt = 0; let ok = false; let lastErr: any = null;
      const testArtifacts: string[] = [];
      while (attempt <= (input.retries ?? 0)) {
        try {
          if (input.traceOnFailure) {
            const page = ensurePage();
            await page.context().tracing.start({ screenshots: true, snapshots: true, sources: false });
          }
          await runSteps(test.steps, "test");
          ok = true;
          if (input.traceOnFailure) {
            const page = ensurePage();
            await page.context().tracing.stop();
          }
          break;
        } catch (e: any) {
          lastErr = e; attempt++;
          if (input.onFailureScreenshot) {
            try {
              const page = ensurePage();
              const file = path.join(artifactsDir, `${sanitizeFilename(test.name)}_attempt${attempt}.png`);
              await page.screenshot({ path: file, fullPage: true });
              testArtifacts.push(file);
            } catch {/* ignore */}
          }
          if (input.traceOnFailure) {
            try {
              const page = ensurePage();
              const file = path.join(artifactsDir, `${sanitizeFilename(test.name)}_attempt${attempt}_trace.zip`);
              await page.context().tracing.stop({ path: file });
              testArtifacts.push(file);
            } catch {/* ignore */}
          }
          if (attempt > (input.retries ?? 0)) break;
        }
      }
      results.tests.push({ name: test.name, ok, error: ok ? undefined : (lastErr?.message ?? String(lastErr)) , artifacts: testArtifacts });
      if (!ok && !input.continueOnError) break;
    }
    if (input.teardown?.length) await runSteps(input.teardown, "teardown");
    if (input.junit) {
      results.junit = buildJUnit(results);
      if (input.junitPath) {
        await fs.writeFile(input.junitPath, results.junit, "utf-8");
      }
    }
    if (shouldAutoBrowser) {
      try { await handlers.browser_close({}); } catch {/* ignore */}
    }
    return { content: [{ type: "text", text: JSON.stringify(results) }] };
  },
  async test_plan_run(input) {
		const results: Array<{ step: number; name: string; ok: boolean; message: string }> = [];
		for (let i = 0; i < input.steps.length; i++) {
			const step = input.steps[i];
			const stepTool = (tools as any)[step.name];
			if (!stepTool || typeof handlers[step.name] !== "function") {
				results.push({ step: i + 1, name: step.name, ok: false, message: "未知工具" });
				if (!input.continueOnError) break;
				continue;
			}
			try {
				const stepArgs = stepTool.inputSchema.parse(step.arguments ?? {});
				await handlers[step.name](stepArgs);
				results.push({ step: i + 1, name: step.name, ok: true, message: "ok" });
			} catch (e: any) {
				results.push({ step: i + 1, name: step.name, ok: false, message: e?.message ?? String(e) });
				if (!input.continueOnError) break;
			}
		}
		return { content: [{ type: "text", text: JSON.stringify(results) }] };
	}
};

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: Object.values(tools).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: (() => {
        const js: any = zodToJsonSchema(t.inputSchema, { $refStrategy: "none" });
        // MCP 规范要求顶层必须是 { type: "object", properties, required?, additionalProperties? }
        return {
          type: "object",
          properties: js?.properties ?? {},
          required: Array.isArray(js?.required) ? js.required : [],
          additionalProperties: typeof js?.additionalProperties === "boolean" ? js.additionalProperties : false
        } as any;
      })()
    }))
  };
});

server.setRequestHandler(CallToolRequestSchema, async (req: any) => {
  const tool = (tools as any)[req.params.name];
  if (!tool) {
    throw new McpError(ErrorCode.MethodNotFound, `未知工具: ${req.params.name}`);
  }
  const input = tool.inputSchema.parse(req.params.arguments ?? {});
  const handler = handlers[req.params.name];
  if (!handler) {
    throw new McpError(ErrorCode.MethodNotFound, `未实现: ${req.params.name}`);
  }
  return handler(input);
});

function ensurePage(): Page {
  if (!state.browser || !state.page) {
    throw new McpError(ErrorCode.InvalidRequest, "请先调用 browser_open 打开浏览器");
  }
  return state.page;
}

function buildJUnit(results: any): string {
  const tests = results.tests.filter((t: any) => typeof t.ok === "boolean");
  const testsCount = tests.length;
  const failures = tests.filter((t: any) => !t.ok).length;
  const cases = tests.map((t: any) => t.ok ? `<testcase name="${escapeXml(t.name)}"/>` : `<testcase name="${escapeXml(t.name)}"><failure message="${escapeXml(t.error || "error")}"/></testcase>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><testsuite name="mcp-web-autotest" tests="${testsCount}" failures="${failures}">${cases}</testsuite>`;
}

function escapeXml(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function sanitizeFilename(name: string): string {
  return String(name).replace(/[^a-zA-Z0-9-_\.]+/g, "_").slice(0, 100);
}

const port = process.env.MCP_PORT ? Number(process.env.MCP_PORT) : 3001;

const transport = new StdioServerTransport();
server.connect(transport);

console.error(`[mcp-web-autotest] 服务已启动（stdio）。调试端口提示: ${port}`);


