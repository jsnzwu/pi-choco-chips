import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { loadSection } from "./settings.ts";

export const DEFAULT_CONFIG = {
  enabled: true,
  provider: "",
  model: "gpt-image-2",
  size: "",
  quality: "",
  outputDir: ".pi/images",
  timeoutMs: 600_000,
};
const QUALITY_VALUES = new Set(["low", "medium", "high", "auto"]);
const MAX_IMAGES = 4;

export function resolveImageGenSettings(overrides = {}) {
  const merged = { ...DEFAULT_CONFIG, ...overrides };
  const timeoutMs = Number(merged.timeoutMs);
  const quality = String(merged.quality || "").toLowerCase();
  return {
    enabled: merged.enabled !== false,
    provider: String(merged.provider || "").trim(),
    model: String(merged.model || "").trim(),
    size: String(merged.size || ""),
    quality: QUALITY_VALUES.has(quality) ? quality : "",
    outputDir: String(merged.outputDir || DEFAULT_CONFIG.outputDir),
    timeoutMs:
      Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_CONFIG.timeoutMs,
  };
}

export function loadImageGenSettings() {
  const { config, error } = loadSection("imagegen", DEFAULT_CONFIG);
  return { settings: resolveImageGenSettings(config), error };
}

export function buildImageRequestBody(settings, params) {
  const body = {
    model: settings.model,
    prompt: params.prompt,
    n: Math.max(1, Math.min(MAX_IMAGES, Number(params.n) || 1)),
  };
  const size = params.size || settings.size;
  if (size) body.size = size;
  const quality = String(params.quality || settings.quality || "").toLowerCase();
  if (quality) {
    if (!QUALITY_VALUES.has(quality)) {
      throw new Error(`quality must be one of ${[...QUALITY_VALUES].join(", ")}`);
    }
    body.quality = quality;
  }
  return body;
}

export function resolveOutputDir(outputDir, cwd) {
  return isAbsolute(outputDir) ? outputDir : resolve(cwd, outputDir);
}

/**
 * Resolve where the request goes from Pi's own configuration: an image model from the
 * registry when the provider has one, otherwise the provider's baseUrl and credentials.
 */
export function resolveImageTarget(settings, registry, currentModel) {
  const provider = settings.provider || currentModel?.provider;
  if (!provider) {
    throw new Error(
      "imagegen.provider is unset and the session has no active provider; set provider in pi-choco-setting.toml",
    );
  }
  const imageModel = registry.getModelOfType("image", provider, settings.model);
  if (imageModel) return { kind: "native", provider, imageModel };
  const probe = registry.getModelsOfType("chat", provider)[0];
  if (!probe) {
    throw new Error(`no models are configured for provider "${provider}" in models.json`);
  }
  return { kind: "http", provider, probe };
}

function mimeFromBytes(buffer) {
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return "image/png";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    buffer.length >= 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  if (buffer.length >= 6 && buffer.toString("ascii", 0, 3) === "GIF") {
    return "image/gif";
  }
  return "image/png";
}

function extensionForMime(mimeType) {
  if (mimeType === "image/jpeg") return ".jpg";
  if (mimeType === "image/webp") return ".webp";
  if (mimeType === "image/gif") return ".gif";
  return ".png";
}

async function imageBufferFromItem(item, fetchImpl) {
  if (typeof item?.b64_json === "string" && item.b64_json.length > 0) {
    return Buffer.from(item.b64_json, "base64");
  }
  const url = item?.url;
  if (typeof url !== "string" || url.length === 0) return undefined;
  if (url.startsWith("data:")) {
    const match = url.match(/^data:([^;]+);base64,(.*)$/s);
    return match ? Buffer.from(match[2], "base64") : undefined;
  }
  if (!/^https?:\/\//i.test(url)) return undefined;
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`image download failed: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

export function outputPathFor(outputDir, cwd, index, mimeType) {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..*/, "")
    .replace("T", "-");
  const suffix = index === 0 ? "" : `-${index + 1}`;
  const name = `image-${stamp}-${randomUUID().slice(0, 8)}${suffix}${extensionForMime(mimeType)}`;
  return join(resolveOutputDir(outputDir, cwd), name);
}

async function saveImages(settings, cwd, buffers) {
  const directory = resolveOutputDir(settings.outputDir, cwd);
  await mkdir(directory, { recursive: true });
  const images = [];
  for (let index = 0; index < buffers.length; index++) {
    const buffer = buffers[index];
    if (!buffer || buffer.length === 0) continue;
    const mimeType = mimeFromBytes(buffer);
    const path = outputPathFor(settings.outputDir, cwd, index, mimeType);
    await writeFile(path, buffer);
    images.push({ path, data: buffer.toString("base64"), mimeType, bytes: buffer.length });
  }
  if (images.length === 0) throw new Error("response carried no decodable image");
  return images;
}

export async function generateImages(connection, settings, params, signal, cwd, fetchImpl = fetch) {
  const body = buildImageRequestBody(settings, params);
  const response = await fetchImpl(`${connection.baseUrl}/images/generations`, {
    method: "POST",
    headers: {
      ...(connection.headers ?? {}),
      authorization: `Bearer ${connection.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.any([signal, AbortSignal.timeout(settings.timeoutMs)]),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 800)}`);
  }
  const payload = JSON.parse(text);
  const items = Array.isArray(payload?.data) ? payload.data : [];
  if (items.length === 0) {
    throw new Error(`response carried no image data: ${text.slice(0, 400)}`);
  }
  const buffers = [];
  for (const item of items) {
    const buffer = await imageBufferFromItem(item, fetchImpl);
    if (buffer && buffer.length > 0) buffers.push(buffer);
  }
  return { body, images: await saveImages(settings, cwd, buffers), usage: payload.usage ?? {} };
}

export async function generateWithImageModel(registry, imageModel, params, settings, cwd) {
  const result = await registry.generateImages(imageModel, {
    input: [{ type: "text", text: params.prompt }],
  });
  if (result.stopReason !== "stop") {
    throw new Error(result.errorMessage || `image model stopped with ${result.stopReason}`);
  }
  const buffers = (result.output ?? [])
    .filter((block) => block.type === "image")
    .map((block) => Buffer.from(block.data, "base64"));
  const images = await saveImages(settings, cwd, buffers);
  return { body: { model: result.model }, images, usage: result.usage ?? {} };
}

function failed(text, details = {}) {
  return { content: [{ type: "text", text }], isError: true, details };
}

function usageLine(usage) {
  return ["input_tokens", "output_tokens", "total_tokens", "input", "output", "totalTokens"]
    .filter((key) => usage?.[key] !== undefined)
    .map((key) => `${key}=${usage[key]}`)
    .join(" ");
}

export default function piChocoImageGen(pi: ExtensionAPI) {
  pi.registerTool({
    name: "image_generate",
    label: "Generate image",
    description:
      "Generate an image through the provider configured in Pi: an image model from the model registry " +
      "when the provider has one, otherwise the provider's OpenAI-compatible POST /v1/images/generations " +
      "endpoint. Use it when the user asks for a raster image that no existing file or diagram already " +
      "covers. It saves the image to disk and shows it inline, and cannot edit an existing image.",
    parameters: Type.Object({
      prompt: Type.String({
        description: "What to draw. Name the subject, style and composition.",
      }),
      size: Type.Optional(
        Type.String({ description: 'Image size such as "1024x1024". Omit for the provider default.' }),
      ),
      quality: Type.Optional(
        Type.String({ description: "low, medium, high or auto. Omit for the provider default." }),
      ),
      n: Type.Optional(Type.Number({ description: "How many images to generate, 1-4. Defaults to 1." })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const { settings, error } = loadImageGenSettings();
      if (!settings.enabled) {
        return failed("Image generation is disabled in the imagegen section of pi-choco-setting.toml.");
      }
      if (!settings.model) {
        return failed("imagegen.model must be set in pi-choco-setting.toml.");
      }

      const cwd = ctx?.cwd ?? process.cwd();
      const abortSignal = signal ?? new AbortController().signal;
      try {
        const target = resolveImageTarget(settings, ctx.modelRegistry, ctx.model);
        let result;
        if (target.kind === "native") {
          result = await generateWithImageModel(ctx.modelRegistry, target.imageModel, params, settings, cwd);
        } else {
          const auth = await ctx.modelRegistry.getApiKeyAndHeaders(target.probe);
          if (!auth.ok) {
            throw new Error(`cannot resolve credentials for provider "${target.provider}": ${auth.error}`);
          }
          const baseUrl = String(auth.baseUrl ?? target.probe.baseUrl ?? "").replace(/\/+$/, "");
          if (!baseUrl) {
            throw new Error(`provider "${target.provider}" has no baseUrl in models.json`);
          }
          result = await generateImages(
            { baseUrl, apiKey: auth.apiKey ?? "", headers: auth.headers },
            settings,
            params,
            abortSignal,
            cwd,
          );
        }

        const lines = [
          `model=${result.body.model} n=${result.images.length}`,
          ...result.images.map((image) => `${image.path} (${image.bytes} bytes)`),
        ];
        const usage = usageLine(result.usage);
        if (usage) lines.push(usage);
        return {
          content: [
            { type: "text", text: lines.join("\n") },
            ...result.images.map((image) => ({
              type: "image",
              data: image.data,
              mimeType: image.mimeType,
            })),
          ],
          details: {
            provider: target.provider,
            model: result.body.model,
            files: result.images.map((image) => image.path),
            usage: result.usage,
          },
        };
      } catch (failure) {
        const message = failure instanceof Error ? failure.message : String(failure);
        const prefix = error ? `settings: ${error}\n` : "";
        return failed(`Image generation failed.\n${prefix}${message}`);
      }
    },
  });
}
