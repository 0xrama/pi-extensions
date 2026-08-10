/**
 * Firecrawl Extension for pi
 *
 * Provides tools for web search, scraping, site mapping, and crawling
 * via the Firecrawl API (https://firecrawl.dev).
 *
 * Tools:
 *   - firecrawl_search: Search the web and get full page content from results
 *   - firecrawl_scrape: Scrape any URL and extract content as markdown, HTML, etc.
 *   - firecrawl_map: Discover all URLs on a website
 *   - firecrawl_crawl: Recursively gather content from entire sites (async)
 *
 * Setup:
 *   Set the FIRECRAWL_API_KEY environment variable, or use /firecrawl-key
 *   to configure it interactively.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";

const DEFAULT_FIRECRAWL_BASE_URL = "http://100.90.128.94:3002";

function getFirecrawlBaseUrl(): string {
	const configured =
		process.env.FIRECRAWL_BASE_URL ||
		process.env.FIRECRAWL_API_URL ||
		DEFAULT_FIRECRAWL_BASE_URL;
	return configured.replace(/\/$/, "").replace(/\/(v1|v2)$/, "");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getApiKey(ctx: ExtensionContext): string | undefined {
	return process.env.FIRECRAWL_API_KEY || ctx.modelRegistry.getApiKey("firecrawl");
}

async function firecrawlRequest(
	path: string,
	body: Record<string, unknown>,
	apiKey: string,
	signal?: AbortSignal,
): Promise<{ ok: boolean; status: number; data: any }> {
	const url = `${getFirecrawlBaseUrl()}${path}`;
	const res = await fetch(url, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
		signal,
	});

	const json = await res.json();
	return { ok: res.ok, status: res.status, data: json };
}

function truncateOutput(raw: string, label: string): string {
	const truncation = truncateHead(raw, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});
	let result = truncation.content;
	if (truncation.truncated) {
		result += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). ${label}]`;
	}
	return result;
}

function ensureApiKey(ctx: ExtensionContext): string {
	const key = getApiKey(ctx);
	if (!key) {
		throw new Error(
			"Firecrawl API key not configured. Set the FIRECRAWL_API_KEY environment variable or run /firecrawl-key.",
		);
	}
	return key;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	// ── Status widget ──────────────────────────────────────────────────────

	pi.on("session_start", (_event, ctx) => {
		const key = getApiKey(ctx);
		const baseUrl = getFirecrawlBaseUrl();
		if (key) {
			ctx.ui.setStatus("firecrawl", `🔥 Firecrawl ${baseUrl}`);
		} else {
			ctx.ui.setStatus("firecrawl", `🔥 Firecrawl ${baseUrl} (no key)`);
		}
	});

	// ── /firecrawl-key command ─────────────────────────────────────────────

	pi.registerCommand("firecrawl-key", {
		description: "Set or show the Firecrawl API key",
		handler: async (_args, ctx) => {
			const current = getApiKey(ctx);
			if (current) {
				ctx.ui.notify(`Current key: ${current.slice(0, 8)}...${current.slice(-4)}`, "info");
			} else {
				ctx.ui.notify("No Firecrawl API key set", "warning");
			}
			const newKey = await ctx.ui.input(
				"Firecrawl API Key",
				current ?? "",
			);
			if (newKey && newKey.trim()) {
				process.env.FIRECRAWL_API_KEY = newKey.trim();
				ctx.ui.setStatus("firecrawl", `🔥 Firecrawl ${getFirecrawlBaseUrl()}`);
				ctx.ui.notify("Firecrawl API key updated", "success");
				// Persist in session
				pi.appendEntry("firecrawl:key-set", { ts: Date.now() });
			}
		},
	});

	// ====================================================================
	// TOOL: firecrawl_search
	// ====================================================================

	pi.registerTool({
		name: "firecrawl_search",
		label: "Firecrawl Search",
		description:
			"Search the web using Firecrawl and get search results with full page content. Returns web results, images, and news articles.",
		promptSnippet: "Search the web and get full page content from results",
		promptGuidelines: [
			"Use firecrawl_search when the user asks to search the web, look something up online, find information about a topic, or get current web results.",
			"Prefer firecrawl_search over bash-based web search for reliable results.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Search query string" }),
			limit: Type.Optional(
				Type.Integer({
					description: "Maximum number of results to return (default: 5, max: 100)",
					minimum: 1,
					maximum: 100,
				}),
			),
			scrapeOptions: Type.Optional(
				Type.Object({
					formats: Type.Optional(
						Type.Array(
							StringEnum(["markdown", "html", "links", "screenshot", "rawHtml"] as const),
							{ description: "Content formats to extract from each result page" },
						),
					),
				}),
			),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const apiKey = ensureApiKey(ctx);

			const body: Record<string, unknown> = {
				query: params.query,
				limit: params.limit ?? 5,
			};
			if (params.scrapeOptions) {
				body.scrapeOptions = params.scrapeOptions;
			}

			const { ok, status, data } = await firecrawlRequest("/v2/search", body, apiKey, signal);

			if (!ok) {
				const msg = data?.error ?? data?.message ?? JSON.stringify(data);
				throw new Error(`Firecrawl search failed (${status}): ${msg}`);
			}

			if (!data.success) {
				throw new Error(`Firecrawl search error: ${JSON.stringify(data)}`);
			}

			const resultData = data.data;
			const parts: string[] = [];

			// Web results
			if (resultData.web?.length) {
				parts.push("=== Web Results ===");
				for (const r of resultData.web) {
					parts.push(`[${r.position}] ${r.title}`);
					parts.push(`    URL: ${r.url}`);
					if (r.description) parts.push(`    ${r.description}`);
					if (r.markdown) {
						parts.push(`    --- Content ---`);
						parts.push(truncateOutput(r.markdown, "Use firecrawl_scrape for full page content"));
					}
					parts.push("");
				}
			}

			// News results
			if (resultData.news?.length) {
				parts.push("=== News Results ===");
				for (const r of resultData.news) {
					parts.push(`[${r.position}] ${r.title}`);
					parts.push(`    URL: ${r.url}`);
					if (r.snippet) parts.push(`    ${r.snippet}`);
					if (r.date) parts.push(`    Date: ${r.date}`);
					parts.push("");
				}
			}

			// Image results
			if (resultData.images?.length) {
				parts.push("=== Image Results ===");
				for (const r of resultData.images) {
					parts.push(`[${r.position}] ${r.title}`);
					parts.push(`    Image: ${r.imageUrl}`);
					parts.push(`    Source: ${r.url}`);
					parts.push("");
				}
			}

			if (parts.length === 0) {
				parts.push("No results found.");
			}

			const text = truncateOutput(
				parts.join("\n"),
				"Full output too large",
			);

			return {
				content: [{ type: "text", text }],
				details: {
					query: params.query,
					webCount: resultData.web?.length ?? 0,
					newsCount: resultData.news?.length ?? 0,
					imageCount: resultData.images?.length ?? 0,
				},
			};
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("firecrawl_search "));
			text += theme.fg("accent", `"${args.query}"`);
			if (args.limit) {
				text += theme.fg("dim", ` (limit: ${args.limit})`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, { isPartial, expanded }, theme) {
			if (isPartial) {
				return new Text(theme.fg("warning", "Searching the web..."), 0, 0);
			}
			const d = result.details;
			let text = theme.fg("success", `✓ Search complete`);
			if (d) {
				const counts: string[] = [];
				if (d.webCount) counts.push(`${d.webCount} web`);
				if (d.newsCount) counts.push(`${d.newsCount} news`);
				if (d.imageCount) counts.push(`${d.imageCount} images`);
				if (counts.length) text += ` (${counts.join(", ")})`;
			}
			if (expanded) {
				const content = result.content[0];
				if (content?.type === "text") {
					const lines = content.text.split("\n").slice(0, 30);
					text += "\n" + lines.map((l) => theme.fg("dim", l)).join("\n");
					if (content.text.split("\n").length > 30) {
						text += "\n" + theme.fg("muted", "... (expand truncated output in tool content)");
					}
				}
			}
			return new Text(text, 0, 0);
		},
	});

	// ====================================================================
	// TOOL: firecrawl_scrape
	// ====================================================================

	pi.registerTool({
		name: "firecrawl_scrape",
		label: "Firecrawl Scrape",
		description:
			"Scrape any URL and extract its content as markdown, HTML, structured JSON, screenshots, and more. Handles JavaScript rendering, anti-bot measures, and proxies automatically.",
		promptSnippet: "Extract content from any URL as markdown, HTML, or structured data",
		promptGuidelines: [
			"Use firecrawl_scrape when the user asks to fetch, extract, or read content from a specific URL.",
			"Use firecrawl_scrape instead of bash curl for reliable rendering of JavaScript-heavy pages.",
			"For interactive pages where you need to click buttons or fill forms, use firecrawl_interact.",
		],
		parameters: Type.Object({
			url: Type.String({ description: "The URL to scrape" }),
			formats: Type.Optional(
				Type.Array(
					StringEnum(["markdown", "html", "rawHtml", "links", "screenshot", "extract"] as const),
					{
						description:
							"Output formats. Default: ['markdown']. Use 'extract' for structured JSON extraction via an extractionPrompt.",
					},
				),
			),
			extractionPrompt: Type.Optional(
				Type.String({
					description:
						"Natural language prompt describing what data to extract. Requires 'extract' in formats.",
				}),
			),
			extractionSchema: Type.Optional(
				Type.Object({
					type: Type.Literal("object"),
					properties: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
					required: Type.Optional(Type.Array(Type.String())),
				}, { description: "JSON schema for structured extraction (used with 'extract' format)." }),
			),
			onlyMainContent: Type.Optional(
				Type.Boolean({ description: "Only extract the main content (skip navigation, footers, etc.). Default: true." }),
			),
			includeTags: Type.Optional(
				Type.Array(Type.String(), { description: "HTML tag names to include in extraction" }),
			),
			excludeTags: Type.Optional(
				Type.Array(Type.String(), { description: "HTML tag names to exclude from extraction" }),
			),
			timeout: Type.Optional(
				Type.Integer({
					description: "Timeout in milliseconds (default: 30000)",
					minimum: 1000,
					maximum: 120000,
				}),
			),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const apiKey = ensureApiKey(ctx);

			const body: Record<string, unknown> = {
				url: params.url,
				formats: params.formats ?? ["markdown"],
			};
			if (params.extractionPrompt) body.extractionPrompt = params.extractionPrompt;
			if (params.extractionSchema) body.extractionSchema = params.extractionSchema;
			if (params.onlyMainContent !== undefined) body.onlyMainContent = params.onlyMainContent;
			if (params.includeTags) body.includeTags = params.includeTags;
			if (params.excludeTags) body.excludeTags = params.excludeTags;
			if (params.timeout) body.timeout = params.timeout;

			const { ok, status, data } = await firecrawlRequest("/v2/scrape", body, apiKey, signal);

			if (!ok) {
				const msg = data?.error ?? data?.message ?? JSON.stringify(data);
				throw new Error(`Firecrawl scrape failed (${status}): ${msg}`);
			}

			if (!data.success) {
				throw new Error(`Firecrawl scrape error: ${JSON.stringify(data)}`);
			}

			const resultData = data.data;
			const parts: string[] = [];

			if (resultData.metadata) {
				const meta = resultData.metadata;
				parts.push(`=== Page Metadata ===`);
				if (meta.title) parts.push(`Title: ${meta.title}`);
				if (meta.description) parts.push(`Description: ${meta.description}`);
				if (meta.language) parts.push(`Language: ${meta.language}`);
				if (meta.sourceURL) parts.push(`Source: ${meta.sourceURL}`);
				if (meta.statusCode) parts.push(`Status: ${meta.statusCode}`);
				parts.push("");
			}

			if (resultData.markdown) {
				parts.push("=== Markdown Content ===");
				parts.push(resultData.markdown);
			}

			if (resultData.html) {
				parts.push("=== HTML Content ===");
				parts.push(truncateOutput(resultData.html, "Full HTML saved separately"));
			}

			if (resultData.rawHtml) {
				parts.push("=== Raw HTML ===");
				parts.push(truncateOutput(resultData.rawHtml, "Full raw HTML saved separately"));
			}

			if (resultData.links?.length) {
				parts.push("=== Links ===");
				for (const link of resultData.links.slice(0, 50)) {
					parts.push(`- ${link}`);
				}
				if (resultData.links.length > 50) {
					parts.push(`... and ${resultData.links.length - 50} more`);
				}
			}

			if (resultData.extract) {
				parts.push("=== Extracted Data ===");
				parts.push(JSON.stringify(resultData.extract, null, 2));
			}

			if (parts.length === 0) {
				parts.push("No content extracted.");
			}

			const text = truncateOutput(parts.join("\n"), "Output truncated");

			return {
				content: [{ type: "text", text }],
				details: {
					url: params.url,
					title: resultData.metadata?.title,
					statusCode: resultData.metadata?.statusCode,
					formats: params.formats ?? ["markdown"],
				},
			};
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("firecrawl_scrape "));
			text += theme.fg("accent", args.url);
			if (args.formats) {
				text += theme.fg("dim", ` [${args.formats.join(", ")}]`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, { isPartial, expanded }, theme) {
			if (isPartial) {
				return new Text(theme.fg("warning", "Scraping page..."), 0, 0);
			}
			const d = result.details;
			let text = theme.fg("success", "✓ Scraped");
			if (d?.title) text += ` ${d.title}`;
			if (d?.statusCode) text += theme.fg("dim", ` (${d.statusCode})`);
			if (d?.formats) text += theme.fg("muted", ` [${d.formats.join(", ")}]`);

			if (expanded) {
				const content = result.content[0];
				if (content?.type === "text") {
					const lines = content.text.split("\n").slice(0, 30);
					text += "\n" + lines.map((l) => theme.fg("dim", l)).join("\n");
					if (content.text.split("\n").length > 30) {
						text += "\n" + theme.fg("muted", "...");
					}
				}
			}
			return new Text(text, 0, 0);
		},
	});

	// ====================================================================
	// TOOL: firecrawl_map
	// ====================================================================

	pi.registerTool({
		name: "firecrawl_map",
		label: "Firecrawl Map",
		description:
			"Discover all URLs on a website. Returns a list of all found URLs, useful for understanding site structure before crawling.",
		promptSnippet: "Discover all URLs on a website",
		promptGuidelines: [
			"Use firecrawl_map when the user wants to see all pages/URLs on a website, understand site structure, or find specific pages.",
		],
		parameters: Type.Object({
			url: Type.String({ description: "The base URL to map" }),
			limit: Type.Optional(
				Type.Integer({
					description: "Maximum number of URLs to return (default: 100, max: 10000)",
					minimum: 1,
					maximum: 10000,
				}),
			),
			search: Type.Optional(
				Type.String({ description: "Filter URLs by matching this substring in their content" }),
			),
			includeSubdomains: Type.Optional(
				Type.Boolean({ description: "Include subdomains in the map. Default: false." }),
			),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const apiKey = ensureApiKey(ctx);

			const body: Record<string, unknown> = {
				url: params.url,
				limit: params.limit ?? 100,
			};
			if (params.search) body.search = params.search;
			if (params.includeSubdomains !== undefined) body.includeSubdomains = params.includeSubdomains;

			const { ok, status, data } = await firecrawlRequest("/v1/map", body, apiKey, signal);

			if (!ok) {
				const msg = data?.error ?? data?.message ?? JSON.stringify(data);
				throw new Error(`Firecrawl map failed (${status}): ${msg}`);
			}

			if (!data.success) {
				throw new Error(`Firecrawl map error: ${JSON.stringify(data)}`);
			}

			const urls: string[] = data.data ?? data.links ?? [];
			const parts: string[] = [
				`=== Site Map: ${params.url} ===`,
				`Found ${urls.length} URLs`,
				"",
			];

			for (const url of urls) {
				parts.push(`- ${url}`);
			}

			const text = truncateOutput(parts.join("\n"), "Output truncated");

			return {
				content: [{ type: "text", text }],
				details: {
					url: params.url,
					count: urls.length,
					search: params.search,
				},
			};
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("firecrawl_map "));
			text += theme.fg("accent", args.url);
			if (args.search) {
				text += theme.fg("dim", ` search="${args.search}"`);
			}
			if (args.limit) {
				text += theme.fg("dim", ` (limit: ${args.limit})`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, { isPartial, expanded }, theme) {
			if (isPartial) {
				return new Text(theme.fg("warning", "Mapping site..."), 0, 0);
			}
			const d = result.details;
			let text = theme.fg("success", `✓ ${d?.count ?? 0} URLs mapped`);

			if (expanded) {
				const content = result.content[0];
				if (content?.type === "text") {
					const lines = content.text.split("\n").slice(0, 50);
					text += "\n" + lines.map((l) => theme.fg("dim", l)).join("\n");
					if (content.text.split("\n").length > 50) {
						text += "\n" + theme.fg("muted", "...");
					}
				}
			}
			return new Text(text, 0, 0);
		},
	});

	// ====================================================================
	// TOOL: firecrawl_crawl
	// ====================================================================

	pi.registerTool({
		name: "firecrawl_crawl",
		label: "Firecrawl Crawl",
		description:
			"Recursively gather content from entire websites. Returns crawled pages with their content. Note: crawling large sites can take time and consume API credits.",
		promptSnippet: "Recursively gather content from entire websites",
		promptGuidelines: [
			"Use firecrawl_crawl when the user wants to extract content from an entire website or multiple pages on a site.",
			"Use firecrawl_scrape for individual pages, firecrawl_map to preview URLs first.",
			"Be mindful of crawl limits — large sites can consume significant credits.",
		],
		parameters: Type.Object({
			url: Type.String({ description: "The starting URL to crawl" }),
			limit: Type.Optional(
				Type.Integer({
					description: "Maximum number of pages to crawl (default: 10, max: 10000)",
					minimum: 1,
					maximum: 10000,
				}),
			),
			formats: Type.Optional(
				Type.Array(
					StringEnum(["markdown", "html", "rawHtml", "links", "screenshot", "extract"] as const),
					{ description: "Content formats to extract per page. Default: ['markdown']" },
				),
			),
			maxDepth: Type.Optional(
				Type.Integer({
					description: "Maximum crawl depth (default: 2)",
					minimum: 1,
					maximum: 10,
				}),
			),
			allowBackwardCrawling: Type.Optional(
				Type.Boolean({ description: "Allow crawling parent URLs outside the start URL's path. Default: false." }),
			),
			excludePaths: Type.Optional(
				Type.Array(Type.String(), { description: "Glob patterns for URL paths to exclude (e.g. '/blog/*', '/admin/*')" }),
			),
			includePaths: Type.Optional(
				Type.Array(Type.String(), { description: "Glob patterns for URL paths to include" }),
			),
			timeout: Type.Optional(
				Type.Integer({
					description: "Timeout in milliseconds (default: 30000)",
					minimum: 1000,
					maximum: 120000,
				}),
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const apiKey = ensureApiKey(ctx);

			const body: Record<string, unknown> = {
				url: params.url,
				limit: params.limit ?? 10,
				formats: params.formats ?? ["markdown"],
			};
			if (params.maxDepth) body.maxDepth = params.maxDepth;
			if (params.allowBackwardCrawling !== undefined) body.allowBackwardCrawling = params.allowBackwardCrawling;
			if (params.excludePaths) body.excludePaths = params.excludePaths;
			if (params.includePaths) body.includePaths = params.includePaths;
			if (params.timeout) body.timeout = params.timeout;

			onUpdate?.({ content: [{ type: "text", text: "Starting crawl..." }] });

			const { ok, status, data } = await firecrawlRequest("/v1/crawl", body, apiKey, signal);

			if (!ok) {
				const msg = data?.error ?? data?.message ?? JSON.stringify(data);
				throw new Error(`Firecrawl crawl failed (${status}): ${msg}`);
			}

			if (!data.success) {
				throw new Error(`Firecrawl crawl error: ${JSON.stringify(data)}`);
			}

			// Handle async crawl (returns an ID for polling)
			if (data.id) {
				const crawlId = data.id;
				onUpdate?.({
					content: [{ type: "text", text: `Crawl started (ID: ${crawlId}). Polling for results...` }],
				});

				// Poll for completion
				const pollUrl = `${getFirecrawlBaseUrl()}/v1/crawl/${crawlId}`;
				let pollCount = 0;
				const maxPolls = 120; // 120 * 5s = 10 minutes max

				while (pollCount < maxPolls) {
					if (signal?.aborted) {
						throw new Error("Crawl cancelled");
					}

					await new Promise((r) => setTimeout(r, 5000));
					pollCount++;

					const pollRes = await fetch(pollUrl, {
						headers: { Authorization: `Bearer ${apiKey}` },
						signal,
					});
					const pollData = await pollRes.json();

					if (pollData.status === "completed") {
						const pages: any[] = pollData.data ?? [];
						const parts: string[] = [
							`=== Crawl Results: ${params.url} ===`,
							`Crawled ${pages.length} pages`,
							"",
						];

						for (const page of pages) {
							parts.push(`--- ${page.url} ---`);
							if (page.markdown) {
								parts.push(truncateOutput(page.markdown, "Use firecrawl_scrape for full content"));
							} else if (page.html) {
								parts.push(truncateOutput(page.html, "Output truncated"));
							} else if (page.extracted) {
								parts.push(JSON.stringify(page.extracted, null, 2));
							}
							parts.push("");
						}

						const text = truncateOutput(parts.join("\n"), "Crawl output truncated");
						return {
							content: [{ type: "text", text }],
							details: {
								url: params.url,
								crawlId,
								pageCount: pages.length,
								status: "completed",
							},
						};
					}

					if (pollData.status === "failed" || pollData.status === "cancelled") {
						throw new Error(`Crawl ${pollData.status}: ${JSON.stringify(pollData.error ?? pollData)}`);
					}

					if (pollCount % 6 === 0) {
						onUpdate?.({
							content: [{
								type: "text",
								text: `Crawl in progress... (${pollCount * 5}s elapsed)`,
							}],
						});
					}
				}

				throw new Error("Crawl timed out after 10 minutes");
			}

			// Handle synchronous crawl (data returned directly)
			const pages: any[] = data.data ?? [];
			const parts: string[] = [
				`=== Crawl Results: ${params.url} ===`,
				`Crawled ${pages.length} pages`,
				"",
			];

			for (const page of pages) {
				parts.push(`--- ${page.url} ---`);
				if (page.markdown) {
					parts.push(truncateOutput(page.markdown, "Use firecrawl_scrape for full content"));
				} else if (page.html) {
					parts.push(truncateOutput(page.html, "Output truncated"));
				}
				parts.push("");
			}

			const text = truncateOutput(parts.join("\n"), "Crawl output truncated");
			return {
				content: [{ type: "text", text }],
				details: {
					url: params.url,
					pageCount: pages.length,
					status: "completed",
				},
			};
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("firecrawl_crawl "));
			text += theme.fg("accent", args.url);
			if (args.limit) {
				text += theme.fg("dim", ` (max: ${args.limit} pages)`);
			}
			if (args.maxDepth) {
				text += theme.fg("dim", ` (depth: ${args.maxDepth})`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, { isPartial, expanded }, theme) {
			if (isPartial) {
				return new Text(theme.fg("warning", "Crawling site..."), 0, 0);
			}
			const d = result.details;
			let text = theme.fg("success", `✓ Crawled ${d?.pageCount ?? 0} pages`);

			if (expanded) {
				const content = result.content[0];
				if (content?.type === "text") {
					const lines = content.text.split("\n").slice(0, 40);
					text += "\n" + lines.map((l) => theme.fg("dim", l)).join("\n");
					if (content.text.split("\n").length > 40) {
						text += "\n" + theme.fg("muted", "...");
					}
				}
			}
			return new Text(text, 0, 0);
		},
	});
}
