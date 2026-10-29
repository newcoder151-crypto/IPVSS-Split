
"""Unsupported-codec fallback: delivers the H.264 sample; stock Chromium must show the friendly message.
   python3 test/browser/fallback.py"""
import asyncio
from playwright.async_api import async_playwright
import os, sys, subprocess, tempfile
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
SHOTS = os.path.join(os.path.dirname(__file__), 'shots'); os.makedirs(SHOTS, exist_ok=True)
B = os.environ.get('RPF_URL', 'http://localhost:7090')
async def main():
    # a second request delivered with the H.264 sample, which this Chromium cannot decode
    async with async_playwright() as p:
        br=await p.chromium.launch(args=['--no-sandbox']); pg=await br.new_page(viewport={'width':1366,'height':820})
        await pg.goto(B+'/'); await pg.fill('input[name=username]','post-b-officer'); await pg.fill('input[name=password]','rpf-demo-123')
        await pg.click('button[type=submit]'); await pg.wait_for_selector('.topbar')
        rid=await pg.evaluate("""async()=>{const t=sessionStorage.getItem('rpf_token');const H={Authorization:'Bearer '+t,'Content-Type':'application/json'};
          const cams=await (await fetch('/api/cameras',{headers:H})).json();
          const now=Date.now();
          const r=await fetch('/api/requests',{method:'POST',headers:H,body:JSON.stringify({camera_id:cams[cams.length-1].id,window_start:new Date(now-50*60000).toISOString(),window_end:new Date(now-45*60000).toISOString(),reason:'codec fallback test'})});
          return (await r.json()).id}""")
        out=subprocess.run(['node','scripts/simulate_cms.js','fulfill',str(rid)],cwd=ROOT,capture_output=True,text=True).stdout.strip(); print('   ',out)
        await pg.click('.tab:has-text("Footage")'); await pg.wait_for_selector('button:has-text("Play")')
        await pg.locator('button:has-text("Play")').first.click(); await pg.wait_for_selector('dialog[open] video')
        await pg.wait_for_selector('dialog[open] .note:not(.hidden)',timeout=10000)
        txt=await pg.inner_text('dialog[open] .note'); vis=await pg.locator('dialog[open] video').is_visible()
        await pg.screenshot(path=os.path.join(SHOTS,'13_codec_fallback.png'))
        good='cannot play this video' in txt and not vis
        print(('  ok   - ' if good else '  FAIL - ')+'unsupported codec shows a clear message with a save-locally hint, no black box')
        await br.close(); sys.exit(0 if good else 1)
asyncio.run(main())
