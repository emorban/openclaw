import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { renderSocialPreviewSvg, socialPreviewFontFiles } from "./control-ui-social-preview.ts";

/** The same scene supplies the still fallback and the versioned motion asset. */
export function controlUiSocialCardPlugin(): Plugin {
  return {
    name: "control-ui-social-card",
    apply: "build",
    async buildStart() {
      const { Resvg } = await import("@resvg/resvg-js");
      const image = new Resvg(renderSocialPreviewSvg(), {
        font: {
          loadSystemFonts: false,
          fontFiles: socialPreviewFontFiles.map((file) => fileURLToPath(file)),
        },
      });
      this.emitFile({ type: "asset", fileName: "social-card.png", source: image.render().asPng() });
    },
  };
}
