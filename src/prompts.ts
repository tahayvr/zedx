import * as p from "@clack/prompts";
import color from "picocolors";
import type {
  ExtensionOptions,
  ExtensionType,
  License,
} from "./types/index.js";

export async function promptUser(): Promise<ExtensionOptions> {
  p.intro(color.bgBlue(" zedx "));

  const group = await p.group(
    {
      name: () =>
        p.text({
          message: "Project name:",
          placeholder: color.dim("my-zed-extension"),
          initialValue: "my-zed-extension",
          validate: (value: string | undefined) => {
            if (!value || value.length === 0) return "Name is required";
          },
        }),
      id: ({ results }) =>
        p.text({
          message: "Extension ID:",
          placeholder: color.dim("my-zed-extension"),
          initialValue:
            results.name?.toLowerCase().replace(/\s+/g, "-") ??
            "my-zed-extension",
          validate: (value: string | undefined) => {
            if (!value || value.length === 0) return "ID is required";
          },
        }),
      description: () =>
        p.text({
          message: "Description:",
          initialValue: color.dim("A Zed theme"),
        }),
      author: () =>
        p.text({
          message: "Author name:",
          validate: (value: string | undefined) => {
            if (!value || value.length === 0) return "Author is required";
          },
        }),
      repository: ({ results }) =>
        p.text({
          message: "GitHub repository URL:",
          initialValue: color.dim(
            `https://github.com/${results.author ?? ""}/`,
          ),
        }),
      license: () =>
        p.select({
          message: "License:",
          options: [
            { value: "Apache-2.0", label: "Apache 2.0" },
            { value: "BSD-2-Clause", label: "BSD 2-Clause" },
            { value: "BSD-3-Clause", label: "BSD 3-Clause" },
            { value: "GPL-3.0", label: "GNU GPLv3" },
            { value: "LGPL-3.0", label: "GNU LGPLv3" },
            { value: "MIT", label: "MIT" },
            { value: "Zlib", label: "zlib" },
          ],
          initialValue: "MIT",
        }),
    },
    {
      onCancel: () => {
        p.cancel("Cancelled.");
        process.exit(0);
      },
    },
  );

  const options: ExtensionOptions = {
    name: String(group.name),
    id: String(group.id),
    description: String(group.description),
    author: String(group.author),
    repository: String(group.repository),
    license: group.license as License,
    types: ["theme"] as ExtensionType[],
  };

  return options;
}

export async function promptThemeDetails(): Promise<{
  themeName: string;
  appearance: "light" | "dark" | "both";
}> {
  const { themeName } = await p.group(
    {
      themeName: () =>
        p.text({
          message: "Theme name:",
          initialValue: "My Theme",
        }),
    },
    {
      onCancel: () => {
        p.cancel("Operation cancelled.");
        process.exit(0);
      },
    },
  );

  const appearance = await p.select({
    message: "Appearance:",
    options: [
      { value: "dark", label: "Dark" },
      { value: "light", label: "Light" },
      { value: "both", label: "Both (Dark & Light)" },
    ],
    initialValue: "dark",
  });
  if (p.isCancel(appearance)) {
    p.cancel("Cancelled.");
    process.exit(0);
  }

  return {
    themeName: String(themeName),
    appearance: appearance as "light" | "dark" | "both",
  };
}
