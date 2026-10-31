import {defineConfig} from "playwright/test";
export default defineConfig({
  testDir:"./e2e",fullyParallel:false,workers:1,timeout:45000,globalTimeout:180000,
  expect:{timeout:10000},
  outputDir:".superpowers/ui-results",
  reporter:[["list"]],
  use:{baseURL:"http://127.0.0.1:1438",headless:true,launchOptions:{timeout:30000},
    ...(process.platform==="win32"?{channel:"msedge"}:{}),
    screenshot:"only-on-failure",trace:"retain-on-failure"},
  projects:[
    {name:"desktop",use:{viewport:{width:1100,height:780}}},
    {name:"mobile",use:{viewport:{width:390,height:844}}},
  ],
  webServer:{command:"npm run preview -- --host 127.0.0.1 --port 1438 --strictPort",url:"http://127.0.0.1:1438",reuseExistingServer:false,timeout:60000},
});
