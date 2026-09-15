import staticAdapter from "@sveltejs/adapter-static";
import * as cheerio from "cheerio";
import { existsSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import sharp from "sharp";
import glob from "tiny-glob";

const PAGES_DIR = "./build";

/**
 * @typedef {Object} AdapterOptions
 * @property {string} [manifestFile]
 * @property {boolean} [generateAppIconVariants]
 */

/**
 * @param {AdapterOptions} [options]
 */
export default function (options) {
  return {
    name: "Chrome Extension Adapter",

    async adapt(builder) {
      await staticAdapter().adapt(builder);

      const manifestFile = options?.manifestFile ?? "manifest.json";

      await extractInlineScripts(builder);
      await writeExtensionManifest(builder, manifestFile);

      if (options?.generateAppIconVariants !== false) {
        await generateAppIconVariants(builder, manifestFile);
      }
    },
  };
}

/**
 * @param {string} value
 */
function hash(value) {
  let hash = 5381;
  let i = value.length;

  while (i) {
    hash = (hash * 33) ^ value.charCodeAt(--i);
  }

  return (hash >>> 0).toString(36);
}

/**
 * @param {import("@sveltejs/kit").Builder} builder
 */
async function extractInlineScripts(builder) {
  const { log } = builder;

  const filePaths = await glob("**/*.html", {
    cwd: PAGES_DIR,
    dot: true,
    filesOnly: true,
    absolute: true,
  });

  for (const filePath of filePaths) {
    const file = readFileSync(filePath, "utf-8");
    const $ = cheerio.load(file);
    const node = $("script:not([src])").first();

    if (node.length > 0) {
      const scriptContent = node.html();

      if (!scriptContent) continue;

      const scriptHash = hash(scriptContent);
      const scriptFileName = `script-${scriptHash}.js`;
      const scriptFilePath = path.join(PAGES_DIR, scriptFileName);

      writeFileSync(scriptFilePath, scriptContent, "utf-8");

      node.attr("src", scriptFileName);
      node.empty();

      writeFileSync(filePath, $.html(), "utf-8");

      log(`Extracted inline script from ${filePath} to ${scriptFileName}`);
    }
  }
}

/**
 * @param {import("@sveltejs/kit").Builder} builder
 * @param {string} manifestFile
 */
async function writeExtensionManifest(builder, manifestFile) {
  const { log, getClientDirectory, copy } = builder;

  const manifestPath = path.join(getClientDirectory(), manifestFile);

  if (!existsSync(manifestPath)) {
    log.error(
      `Could not find ${manifestFile} in the client directory. Please ensure it exists.`,
    );
    return;
  }

  copy(manifestPath, path.join(PAGES_DIR, "manifest.json"));

  log.success(`Copied ${manifestFile} to ${PAGES_DIR}`);
}

/**
 * @param {string} sourcePath
 * @param {string} destPath
 * @param {number} size
 */
async function writeIconVariant(sourcePath, destPath, size) {
  const source = readFileSync(sourcePath);
  const meta = await sharp(source).metadata();

  const density =
    meta.format === "svg" && meta.width
      ? Math.min(Math.ceil((72 * size) / meta.width), 2400)
      : undefined;

  await sharp(source, density ? { density } : {})
    .resize(size, size, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png({ compressionLevel: 9 })
    .toFile(destPath);
}

/**
 * @typedef {Object} Manifest
 * @property {{
 *   default_icon?: string | Record<string, string>
 * }=} action
 * @property {Record<string, string>=} icons
 */

/**
 * @param {import("@sveltejs/kit").Builder} builder
 * @param {string} manifestFile
 */
async function generateAppIconVariants(builder, manifestFile) {
  const { log, getClientDirectory } = builder;

  const manifestPath = path.join(getClientDirectory(), manifestFile);

  if (!existsSync(manifestPath)) {
    log.error(
      `Could not find ${manifestFile} in the client directory. Please ensure it exists.`,
    );
    return;
  }

  /** @type {Manifest} */
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));

  if (manifest.action && typeof manifest.action.default_icon === "string") {
    const iconPath = path.join(
      getClientDirectory(),
      manifest.action.default_icon,
    );

    if (existsSync(iconPath)) {
      const sizes = [16, 24, 32];
      const icons = {};

      for (const size of sizes) {
        const fileName = `icon-${size}.png`;

        await writeIconVariant(iconPath, path.join(PAGES_DIR, fileName), size);

        icons[String(size)] = fileName;
      }

      const builtManifestPath = path.join(PAGES_DIR, "manifest.json");

      /** @type {Manifest} */
      const builtManifest = JSON.parse(
        readFileSync(builtManifestPath, "utf-8"),
      );

      builtManifest.action.default_icon = icons;
      builtManifest.icons ??= icons;

      writeFileSync(
        builtManifestPath,
        JSON.stringify(builtManifest, null, 2),
        "utf-8",
      );

      log.success(
        `Copied app icon "${manifest.action.default_icon}" variants to ${PAGES_DIR}`,
      );
    } else {
      log.error(
        `Could not find app icon at ${iconPath}. Please ensure it exists.`,
      );
    }
  } else {
    log.info(
      "Skipped generation of default icons since the \`default_icon\` field is an object.",
    );
  }
}
