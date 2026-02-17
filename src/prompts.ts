import * as p from "@clack/prompts";
import color from "picocolors";
import type {
  ExtensionOptions,
  ExtensionType,
  License,
} from "./types/index.js";

export async function promptUser(): Promise<ExtensionOptions> {
  p.intro(color.bgBlue(" zedx "));

  const name = await p.text({
    message: "Project name:",
    placeholder: "my-zed-extension",
    validate: (value: string | undefined) => {
      if (!value || value.length === 0) return "Name is required";
    },
  });
  if (p.isCancel(name)) {
    p.cancel("Cancelled.");
    process.exit(0);
  }

  const id = await p.text({
    message: "Extension ID:",
    placeholder: "my-zed-extension",
    validate: (value: string | undefined) => {
      if (!value || value.length === 0) return "ID is required";
    },
  });
  if (p.isCancel(id)) {
    p.cancel("Cancelled.");
    process.exit(0);
  }

  const description = await p.text({
    message: "Description:",
  });
  if (p.isCancel(description)) {
    p.cancel("Cancelled.");
    process.exit(0);
  }

  const author = await p.text({
    message: "Author name:",
    validate: (value: string | undefined) => {
      if (!value || value.length === 0) return "Author is required";
    },
  });
  if (p.isCancel(author)) {
    p.cancel("Cancelled.");
    process.exit(0);
  }

  const repository = await p.text({
    message: "GitHub repository URL:",
    placeholder: "https://github.com/",
  });
  if (p.isCancel(repository)) {
    p.cancel("Cancelled.");
    process.exit(0);
  }

  const license = await p.select({
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
  });
  if (p.isCancel(license)) {
    p.cancel("Cancelled.");
    process.exit(0);
  }

  const options: ExtensionOptions = {
    name: String(name),
    id: String(id),
    description: String(description),
    author: String(author),
    repository: String(repository),
    license: license as License,
    types: ["theme"] as ExtensionType[],
  };

  return options;
}

export async function promptThemeDetails(): Promise<{
  themeName: string;
  appearance: "light" | "dark" | "both";
}> {
  const themeName = await p.text({
    message: "Theme name:",
  });
  if (p.isCancel(themeName)) {
    p.cancel("Cancelled.");
    process.exit(0);
  }

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
