import {defineConfig} from '@playwright/test';
import fs from 'node:fs';
export default defineConfig({
  testDir:'./test',testMatch:'*.spec.mjs',workers:1,timeout:120000,
  use:{baseURL:'http://127.0.0.1:9120',trace:'retain-on-failure'},
  projects:[
    {name:'chromium',use:{browserName:'chromium',launchOptions:fs.existsSync('/usr/bin/chromium')?{executablePath:'/usr/bin/chromium',args:['--no-sandbox']}:undefined}},
    {name:'firefox',use:{browserName:'firefox'}},
    {name:'webkit',use:{browserName:'webkit'}}
  ],
  webServer:{command:'node test/server.mjs',port:9120,reuseExistingServer:!process.env.CI}
});
