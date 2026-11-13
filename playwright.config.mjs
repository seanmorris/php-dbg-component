import {defineConfig} from '@playwright/test';
import fs from 'node:fs';

// Where a system Chromium is installed, use it; it runs as root only without its sandbox.
const system = fs.existsSync('/usr/bin/chromium')
	? {executablePath: '/usr/bin/chromium', args: ['--no-sandbox']}
	: undefined;

const projects = [
	{name: 'chromium', use: {browserName: 'chromium', launchOptions: system}}
	, {name: 'firefox', use: {browserName: 'firefox'}}
	, {name: 'webkit', use: {browserName: 'webkit'}}
];

export default defineConfig({
	testDir: './test'
	, testMatch: '*.spec.mjs'
	, workers: 1
	, timeout: 120000
	, expect: {timeout: 30000}

	, outputDir: `test-results/php-${process.env.PHP_VERSION || '8.4'}`
	, use: {baseURL: 'http://127.0.0.1:9120', trace: 'retain-on-failure'}
	, projects
	, webServer: {command: 'node test/server.mjs', port: 9120, reuseExistingServer: !process.env.CI}
});
