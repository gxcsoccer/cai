#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const minimist = require('minimist');
const { Configuration, OpenAIApi } = require('openai');

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function walk(dir, ignoreDirs, fileList) {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (ignoreDirs.has(entry.name)) continue;
      await walk(fullPath, ignoreDirs, fileList);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      const allowedExt = ['.js','.ts','.jsx','.tsx','.py','.go','.java','.c','.cpp','.h','.cs','.rb','.php','.swift','.rs','.sh','.yaml','.yml','.json','.env','.toml','.ini','.md','.txt'];
      if (allowedExt.includes(ext)) {
        fileList.push(fullPath);
      } else {
        try {
          const stats = await fs.promises.stat(fullPath);
          if (stats.size < 1024 * 1024) {
            fileList.push(fullPath);
          }
        } catch {
          // ignore
        }
      }
    }
  }
}

async function searchFiles(files, regex, windowLines, maxResults) {
  const results = [];
  for (const file of files) {
    if (results.length >= maxResults) break;
    try {
      const content = await fs.promises.readFile(file, 'utf8');
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          const start = Math.max(0, i - windowLines);
          const end = Math.min(lines.length, i + windowLines + 1);
          const snippet = lines.slice(start, end).join('\n');
          results.push({ file, line: i + 1, snippet });
          if (results.length >= maxResults) break;
        }
      }
    } catch {
      // ignore binary or unreadable file
    }
  }
  return results;
}

async function main() {
  const args = minimist(process.argv.slice(2), {
    string: ['d'],
    alias: { d: 'dir', n: 'max', w: 'window' },
    default: { d: process.cwd(), n: 5, w: 3 }
  });

  const query = args._.join(' ').trim();
  if (!query) {
    console.error('Please provide a search query.');
    process.exit(1);
  }

  const directory = args.dir;
  const maxResults = parseInt(args.max, 10);
  const windowLines = parseInt(args.window, 10);

  const tokens = query.split(/\s+/).map(t => escapeRegExp(t));
  const regex = new RegExp(tokens.join('|'), 'i');

  const fileList = [];
  const ignoreDirs = new Set(['node_modules','vendor','third_party','.git','dist','build','tests','test','__tests__']);
  await walk(directory, ignoreDirs, fileList);

  const results = await searchFiles(fileList, regex, windowLines, maxResults);

  if (results.length === 0) {
    console.log('No matches found.');
    return;
  }

  let prompt = `The user asked: "${query}". I found the following code snippets and configuration lines in the project:\n`;
  results.forEach((res, idx) => {
    prompt += `\n[${idx+1}] ${res.file}:${res.line}\n${res.snippet}\n`;
  });
  prompt += '\nPlease summarise what these snippets show about the user\'s question. Provide a clear, high-level explanation of the relevant logic, configuration or data flow. Do not repeat the code lines verbatim, but refer to them by their index when necessary.';

  const configuration = new Configuration({
    apiKey: process.env.OPENAI_API_KEY || 'sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  });
  const openai = new OpenAIApi(configuration);

  try {
    const completion = await openai.createChatCompletion({
      model: 'gpt-3.5-turbo',
      messages: [
        { role: 'system', content: 'You are a helpful assistant that summarises code snippets.' },
        { role: 'user', content: prompt }
      ],
      max_tokens: 400,
      temperature: 0.2
    });
    const summary = completion.data.choices[0].message.content.trim();
    console.log(summary);
  } catch (err) {
    console.error('Error calling OpenAI API:', err.message);
    console.log('Snippets:');
    results.forEach((res, idx) => {
      console.log(`[${idx+1}] ${res.file}:${res.line}`);
    });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
