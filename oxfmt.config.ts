import { defineConfig } from "oxfmt";
import ultracite from "ultracite/oxfmt";

// Ultracite's formatter preset. Code stays at 100 columns, as the kit was written; prose keeps its own line breaks,
// so a paragraph's diff shows only the words that changed.
export default defineConfig({ ...ultracite, printWidth: 100, proseWrap: "preserve" });
