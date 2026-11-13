// SMGen builds the documentation site. Until it is on npm, this fetches the commit recorded in
// site/smgen-lock.json into .cache/smgen and prints the path of its command.
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const lock = JSON.parse(await fs.readFile(path.join(root, 'site/smgen-lock.json'), 'utf8'));
const checkout = path.join(root, '.cache/smgen');

const git = (...args) => execFileSync('git', ['-C', checkout, ...args], {encoding: 'utf8'}).trim();

/** The path of smgen.sh at the locked commit, fetched first if it is not there. */
export async function smgenCommand()
{
	let present = '';

	try
	{
		present = git('rev-parse', 'HEAD');
	}
	catch
	{
		await fs.rm(checkout, {recursive: true, force: true});
		await fs.mkdir(checkout, {recursive: true});
		git('init', '--quiet');
		git('remote', 'add', 'origin', lock.repository);
	}

	if(present !== lock.commit)
	{
		git('fetch', '--quiet', '--depth', '1', 'origin', lock.commit);
		git('checkout', '--quiet', '--detach', 'FETCH_HEAD');
	}

	if(git('rev-parse', 'HEAD') !== lock.commit)
	{
		throw Error(`SMGen is not at the locked commit ${lock.commit}`);
	}

	return path.join(checkout, 'smgen.sh');
}

if(process.argv[1] === import.meta.filename)
{
	console.log(await smgenCommand());
}
