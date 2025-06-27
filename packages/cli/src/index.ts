#!/usr/bin/env node
/* packages/cli/src/index.ts */
import { Command } from 'commander';
import inquirer from 'inquirer';
import pc from 'picocolors';
import path from 'node:path';
import fs from 'fs-extra';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';
import { execa } from 'execa';

const banner = `
/**
 *
 *  ██████╗██╗  ██╗██████╗  ██████╗ ███╗   ███╗ █████╗
 * ██╔════╝██║  ██║██╔══██╗██╔═══██╗████╗ ████║██╔══██╗
 * ██║     ███████║██████╔╝██║   ██║██╔████╔██║███████║
 * ██║     ██╔══██║██╔══██╗██║   ██║██║╚██╔╝██║██╔══██║
 * ╚██████╗██║  ██║██║  ██║╚██████╔╝██║ ╚═╝ ██║██║  ██║
 *  ╚═════╝╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝ ╚═╝     ╚═╝╚═╝  ╚═╝
 *
 * Powerful chrome extension framework
 */
`;

console.log(pc.cyan(banner));

const program = new Command();

program
  .name('create-chroma-extension')
  .description('Scaffold a new Chroma-powered browser extension')
  .argument('[dir]', 'project directory', 'my-chroma-extension')
  .option('-l, --local', 'link local Chroma packages (monorepo dev mode)')
  .version('0.1.0')
  .parse(process.argv);

const opts = program.opts<{ local: boolean }>();
const targetDir = path.resolve(process.cwd(), program.args[0]);

const answers = await inquirer.prompt([
  { name: 'name', message: 'Extension name', default: path.basename(targetDir) },
  { name: 'description', message: 'Description', default: 'A Chroma extension' },
  { name: 'author', message: 'Author', default: 'chroma' },
  {
    name: 'pkgManager',
    message: 'Package manager',
    type: 'list',
    choices: ['pnpm', 'npm', 'yarn'],
    default: 'pnpm',
  },
]);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const templateDir = path.join(__dirname, '../template');

await fs.copy(templateDir, targetDir, { overwrite: false, errorOnExist: true });

const pkgJsonPath = path.join(targetDir, 'package.json');
const pkg = JSON.parse(await fs.readFile(pkgJsonPath, 'utf8'));

const chromaVersion = '^0.1.0';
const localRoot = path.join(__dirname, '../../../'); // repo root

['@chroma/core', '@chroma/bridge', '@chroma/react', '@chroma/manifest'].forEach((pkgName) => {
  pkg.dependencies[pkgName] = opts.local
    ? `file:${path.join(localRoot, `packages/${pkgName.split('/')[1]}`)}`
    : chromaVersion;
});

pkg.name = answers.name;
pkg.description = answers.description;
pkg.author = answers.author;

await fs.writeFile(pkgJsonPath, JSON.stringify(pkg, null, 2));

/* chroma.config.ts & README.md get rendered with EJS */
async function renderFile(rel: string) {
  const file = path.join(targetDir, rel);
  const raw = await fs.readFile(file, 'utf8');
  const rendered = ejs.render(raw, { ...answers });
  await fs.writeFile(file, rendered);
}
await Promise.all(['chroma.config.ts', 'README.md'].map(renderFile));

/* -------------------------------------------------------------------------- */
/*                        4. INSTALL DEPENDENCIES                             */
/* -------------------------------------------------------------------------- */
console.log(pc.green('\nInstalling packages – this may take a minute…'));
await execa(answers.pkgManager, ['install'], { cwd: targetDir, stdio: 'inherit' });

/* -------------------------------------------------------------------------- */
/*                       5. DONE – guide the user                             */
/* -------------------------------------------------------------------------- */
console.log(`
${pc.bold(pc.green('Success!'))} Created ${pc.cyan(answers.name)} at ${targetDir}

Inside that directory you can run:

  ${pc.cyan(`${answers.pkgManager} dev`)}   Runs Vite dev-server + reload-on-save
  ${pc.cyan(`${answers.pkgManager} build`)} Generates dist/ with manifest & sw

Happy hacking with ${pc.magenta('Chroma')}!
`);
