#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

function parseArguments(argv) {
  const options = {
    changelog: "CHANGELOG.md",
  };

  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined) {
      throw new Error(`Expected --name value arguments, received: ${argv.join(" ")}`);
    }
    options[name.slice(2)] = value;
  }

  if (!options.version || !options.output) {
    throw new Error(
      "Usage: extract-release-notes.js --version X.Y.Z --output FILE [--changelog FILE] [--changelog-url URL]",
    );
  }

  return options;
}

function headingName(line) {
  const match = /^##\s+(.+?)\s*$/.exec(line);
  if (!match) {
    return undefined;
  }

  let name = match[1].replace(/\s+-\s+\d{4}-\d{2}-\d{2}\s*$/, "").trim();
  if (name.startsWith("[") && name.endsWith("]")) {
    name = name.slice(1, -1);
  }
  return name;
}

function extractSection(changelog, requestedHeading) {
  const lines = changelog.replace(/\r\n/g, "\n").split("\n");
  let start = -1;

  for (let index = 0; index < lines.length; index += 1) {
    if (headingName(lines[index]) === requestedHeading) {
      start = index + 1;
      break;
    }
  }

  if (start === -1) {
    return "";
  }

  let end = lines.length;
  for (let index = start; index < lines.length; index += 1) {
    if (headingName(lines[index]) !== undefined) {
      end = index;
      break;
    }
  }

  return lines.slice(start, end).join("\n").trim();
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const changelogPath = path.resolve(options.changelog);
  const changelog = fs.readFileSync(changelogPath, "utf8");
  const releaseNotes =
    extractSection(changelog, options.version) || extractSection(changelog, "Unreleased");

  if (!releaseNotes) {
    throw new Error(
      `${options.changelog} does not contain a non-empty section for ${options.version} or Unreleased.`,
    );
  }

  const changelogLink = options["changelog-url"]
    ? `\n\nFull changelog: [CHANGELOG.md](${options["changelog-url"]})`
    : "";
  const output = `${releaseNotes}${changelogLink}\n`;
  fs.writeFileSync(path.resolve(options.output), output, "utf8");
  console.log(`Extracted ${options.version} release notes to ${options.output}.`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

module.exports = { extractSection, headingName };
