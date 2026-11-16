import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import piChocoImageGen, {
  buildImageRequestBody,
  generateImages,
  generateWithImageModel,
  outputPathFor,
  resolveImageGenSettings,
  resolveImageTarget,
  resolveOutputDir,
} from "../extensions/imagegen.ts";

const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const workDir = mkdtempSync(join(tmpdir(), "pi-choco-imagegen-"));
after(() => rmSync(workDir, { recursive: true, force: true }));

const settings = resolveImageGenSettings({ provider: " proxy ", model: "gpt-image-2.6", outputDir: "images" });

function createTool() {
  const tools = new Map();
  piChocoImageGen({ registerTool: (definition) => tools.set(definition.name, definition) });
  return tools.get("image_generate");
}

function httpRegistry({ imageModel, models = [{ provider: "proxy", baseUrl: "http://gateway.test/v1" }], auth = { ok: true, apiKey: "sk-test", baseUrl: "http://gateway.test/v1" } } = {}) {
  return {
    getModelOfType: () => imageModel,
    getModelsOfType: () => models,
    getApiKeyAndHeaders: async () => auth,
  };
}

function nativeRegistry(handler) {
  return {
    getModelOfType: (_type, provider, id) => ({ provider, id, api: "openrouter-images", baseUrl: "http://image.test/v1" }),
    getModelsOfType: () => [],
    generateImages: handler,
  };
}

function withAgentSettings(toml, body) {
  const agentDir = mkdtempSync(join(workDir, "agent-"));
  writeFileSync(join(agentDir, "pi-choco-setting.toml"), toml);
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  return Promise.resolve(body()).finally(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  });
}

function withFetch(fetchImpl, body) {
  const previous = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  return Promise.resolve(body()).finally(() => {
    globalThis.fetch = previous;
  });
}

test("resolveImageGenSettings trims provider and model and filters quality", () => {
  assert.equal(settings.provider, "proxy");
  assert.equal(settings.model, "gpt-image-2.6");
  assert.equal(resolveImageGenSettings({ quality: "HIGH" }).quality, "high");
  assert.equal(resolveImageGenSettings({ quality: "ultra" }).quality, "");
  assert.equal(resolveImageGenSettings({ timeoutMs: 0 }).timeoutMs, 600_000);
});

test("buildImageRequestBody applies defaults, overrides and the image cap", () => {
  assert.deepEqual(buildImageRequestBody(settings, { prompt: "a dot" }), {
    model: "gpt-image-2.6",
    prompt: "a dot",
    n: 1,
  });
  assert.deepEqual(
    buildImageRequestBody(settings, { prompt: "a dot", n: 9, size: "512x512", quality: "low" }),
    { model: "gpt-image-2.6", prompt: "a dot", n: 4, size: "512x512", quality: "low" },
  );
  assert.throws(() => buildImageRequestBody(settings, { prompt: "a dot", quality: "ultra" }), /quality must be one of/);
});

test("output paths follow the configured directory and image type", () => {
  assert.equal(resolveOutputDir("images", "/work"), "/work/images");
  assert.equal(resolveOutputDir("/abs/images", "/work"), "/abs/images");
  assert.match(outputPathFor("images", "/work", 1, "image/jpeg"), /^\/work\/images\/image-\d{8}-\d{6}-[0-9a-f]{8}-2\.jpg$/);
});

test("resolveImageTarget prefers a registered image model", () => {
  const imageModel = { provider: "proxy", id: "gpt-image-2.6", api: "openrouter-images" };
  const target = resolveImageTarget(settings, httpRegistry({ imageModel }), undefined);
  assert.equal(target.kind, "native");
  assert.equal(target.imageModel, imageModel);
});

test("resolveImageTarget falls back to the provider connection", () => {
  const target = resolveImageTarget(settings, httpRegistry(), { provider: "proxy" });
  assert.equal(target.kind, "http");
  assert.equal(target.provider, "proxy");
  assert.equal(target.probe.provider, "proxy");
});

test("resolveImageTarget inherits the session provider and rejects unusable providers", () => {
  const target = resolveImageTarget(resolveImageGenSettings({ model: "gpt-image-2" }), httpRegistry(), { provider: "proxy" });
  assert.equal(target.provider, "proxy");
  assert.throws(
    () => resolveImageTarget(resolveImageGenSettings({ model: "gpt-image-2" }), httpRegistry(), undefined),
    /no active provider/,
  );
  assert.throws(
    () => resolveImageTarget(settings, httpRegistry({ models: [] }), undefined),
    /no models are configured for provider "proxy"/,
  );
});

test("generateImages posts the request, forwards headers and writes decoded images", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(
      JSON.stringify({ data: [{ b64_json: PNG_BYTES.toString("base64") }], usage: { input_tokens: 5, output_tokens: 7 } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  const cwd = mkdtempSync(join(workDir, "run-"));
  const result = await generateImages(
    { baseUrl: "http://gateway.test/v1", apiKey: "sk-test", headers: { "x-provider": "pi" } },
    settings,
    { prompt: "a dot" },
    new AbortController().signal,
    cwd,
    fetchImpl,
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://gateway.test/v1/images/generations");
  assert.equal(calls[0].init.headers.authorization, "Bearer sk-test");
  assert.equal(calls[0].init.headers["x-provider"], "pi");
  assert.deepEqual(JSON.parse(calls[0].init.body), { model: "gpt-image-2.6", prompt: "a dot", n: 1 });
  assert.equal(result.images.length, 1);
  assert.equal(result.images[0].mimeType, "image/png");
  assert.deepEqual(readFileSync(result.images[0].path), PNG_BYTES);
  assert.deepEqual(result.usage, { input_tokens: 5, output_tokens: 7 });
});

test("generateImages surfaces HTTP errors", async () => {
  const fetchImpl = async () => new Response('{"error":{"message":"nope"}}', { status: 400 });
  await assert.rejects(
    () =>
      generateImages(
        { baseUrl: "http://gateway.test/v1", apiKey: "sk-test" },
        settings,
        { prompt: "a dot" },
        new AbortController().signal,
        workDir,
        fetchImpl,
      ),
    /HTTP 400/,
  );
});

test("generateWithImageModel saves registry image blocks", async () => {
  const cwd = mkdtempSync(join(workDir, "native-"));
  const registry = {
    generateImages: async () => ({
      api: "openrouter-images",
      provider: "openrouter",
      model: "google/gemini-2.5-flash-image",
      output: [{ type: "image", data: PNG_BYTES.toString("base64"), mimeType: "image/png" }],
      usage: { input: 3, output: 4 },
      stopReason: "stop",
      timestamp: 0,
    }),
  };
  const result = await generateWithImageModel(registry, { id: "google/gemini-2.5-flash-image" }, { prompt: "a dot" }, settings, cwd);
  assert.equal(result.images.length, 1);
  assert.deepEqual(readFileSync(result.images[0].path), PNG_BYTES);

  await assert.rejects(
    () =>
      generateWithImageModel(
        { generateImages: async () => ({ output: [], stopReason: "error", errorMessage: "upstream said no" }) },
        { id: "x" },
        { prompt: "a dot" },
        settings,
        cwd,
      ),
    /upstream said no/,
  );
});

test("image_generate uses the provider connection from Pi and returns an inline image", async () => {
  const toml = ["[imagegen]", 'provider = "proxy"', 'model = "gpt-image-2.6"', 'outputDir = "images"', ""].join("\n");
  await withAgentSettings(toml, () =>
    withFetch(
      async () => new Response(JSON.stringify({ data: [{ b64_json: PNG_BYTES.toString("base64") }] }), { status: 200 }),
      async () => {
        const cwd = mkdtempSync(join(workDir, "session-"));
        const result = await createTool().execute(
          "call-1",
          { prompt: "a dot" },
          new AbortController().signal,
          undefined,
          { cwd, model: { provider: "proxy" }, modelRegistry: httpRegistry() },
        );
        assert.equal(result.isError, undefined);
        assert.equal(result.content[0].type, "text");
        assert.match(result.content[0].text, /model=gpt-image-2\.6/);
        assert.equal(result.content[1].type, "image");
        assert.equal(result.content[1].mimeType, "image/png");
        assert.equal(result.details.provider, "proxy");
        assert.ok(existsSync(result.details.files[0]));
      },
    ),
  );
});

test("image_generate reports unresolved credentials without calling the endpoint", async () => {
  const toml = ["[imagegen]", 'provider = "proxy"', 'model = "gpt-image-2"', ""].join("\n");
  await withAgentSettings(toml, () =>
    withFetch(
      async () => {
        throw new Error("should not be called");
      },
      async () => {
        const result = await createTool().execute("call-2", { prompt: "a dot" }, undefined, undefined, {
          cwd: workDir,
          model: { provider: "proxy" },
          modelRegistry: httpRegistry({ auth: { ok: false, error: "missing IMAGE_API_KEY" } }),
        });
        assert.equal(result.isError, true);
        assert.match(result.content[0].text, /missing IMAGE_API_KEY/);
      },
    ),
  );
});

test("image_generate uses a registry image model when one is configured", async () => {
  const toml = ["[imagegen]", 'provider = "openrouter"', 'model = "flux"', ""].join("\n");
  await withAgentSettings(toml, async () => {
    const result = await createTool().execute("call-3", { prompt: "a dot" }, undefined, undefined, {
      cwd: workDir,
      model: { provider: "openrouter" },
      modelRegistry: nativeRegistry(async () => ({
        output: [{ type: "image", data: PNG_BYTES.toString("base64"), mimeType: "image/png" }],
        model: "flux",
        stopReason: "stop",
      })),
    });
    assert.equal(result.isError, undefined);
    assert.equal(result.details.provider, "openrouter");
    assert.equal(result.content[1].type, "image");
  });
});
