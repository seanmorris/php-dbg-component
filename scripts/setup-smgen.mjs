// SMGen builds the documentation site. Until it is on npm, this fetches the commit recorded in
// site/smgen-lock.json into .cache/smgen and prints the path of its command.
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const lock = JSON.parse(await fs.readFile(path.join(root, 'site/smgen-lock.json'), 'utf8'));
const checkout = path.join(root, '.cache/smgen');

const git = (...args) => execFileSync('git', ['-C', checkout, ...args], {encoding: 'utf8'}).trim();

/** Start the cache directory over as an empty repository whose origin is SMGen's. */
async function prepare()
{
	await fs.rm(checkout, {recursive: true, force: true});
	await fs.mkdir(checkout, {recursive: true});
	git('init', '--quiet');
	git('remote', 'add', 'origin', lock.repository);
}

/** The path of smgen.sh at the locked commit, fetched first if it is not there. */
export async function smgenCommand()
{
	let present = '';

	try
	{
		// For a directory with no repository of its own, git answers for the one around it,
		// which here is this project's. Only a checkout that is its own top level is SMGen's.
		const top = await fs.realpath(git('rev-parse', '--show-toplevel'));

		present = top === await fs.realpath(checkout) ? git('rev-parse', 'HEAD') : '';
	}
	catch
	{
		// No directory, or a repository with nothing in it yet.
	}

	if(!present)
	{
		await prepare();
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
