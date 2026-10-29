"""
Real-browser end-to-end test (Playwright + Chromium) of the RPF dashboard.

Needs: pip install playwright && python -m playwright install chromium, ffmpeg on PATH,
the RPF server running, demo users (npm run seed-demo) and at least one alert delivered
to Post A by CMS. Dev databases only - it writes requests, flags and audit rows.

  python3 test/browser/e2e.py

Stock Chromium has no H.264, so a VP9-in-MP4 clip is generated and delivered through
scripts/simulate_cms.js (SAMPLE_FILE) to prove real playback. test/browser/fallback.py
covers the opposite case, an H.264 file this browser cannot decode.
"""
import asyncio, json
from playwright.async_api import async_playwright
import os, sys, subprocess, tempfile
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
SHOTS = os.path.join(os.path.dirname(__file__), 'shots'); os.makedirs(SHOTS, exist_ok=True)
B = os.environ.get('RPF_URL', 'http://localhost:7090')
problems=[]
def ok(c,m):
    print(('  ok   - ' if c else '  FAIL - ')+m)
    if not c: problems.append(m)

async def login(page,u):
    await page.goto(B+'/')
    await page.fill('input[name=username]',u); await page.fill('input[name=password]','rpf-demo-123')
    await page.click('button[type=submit]'); await page.wait_for_selector('.topbar')

async def main():
    async with async_playwright() as p:
        br=await p.chromium.launch(args=['--no-sandbox'])
        ctx=await br.new_context(viewport={'width':1366,'height':820}, accept_downloads=True)
        page=await ctx.new_page()
        errs=[]
        page.on('pageerror',lambda e:errs.append('pageerror: '+str(e)))
        page.on('console',lambda m:errs.append('console.'+m.type+': '+m.text) if m.type in('error',) else None)
        page.on('response',lambda r:errs.append(f'http {r.status} {r.url}') if r.status>=500 else None)

        print('login screen')
        await page.goto(B+'/'); await page.screenshot(path=SHOTS + '/01_login.png')
        await page.fill('input[name=username]','post-a-officer'); await page.fill('input[name=password]','wrong')
        await page.click('button[type=submit]'); await page.wait_for_selector('.err:not(:empty)')
        ok('invalid' in (await page.inner_text('.err')), 'wrong password shows an error')

        print('officer flow')
        await login(page,'post-a-officer')
        await page.wait_for_selector('table tbody tr')
        ok(await page.locator('.tab').count()==4,'officer has 4 tabs')
        ok(await page.locator('#unacked-pill:not(.hidden)').count()==1,'unacked pill visible')
        await page.screenshot(path=SHOTS + '/02_alert_inbox.png')
        await page.locator('tr.unacked').first.click(); await page.wait_for_selector('.drawer')
        await page.screenshot(path=SHOTS + '/03_alert_drawer.png')
        await page.click('.drawer button:has-text("Acknowledge")')
        await page.wait_for_selector('.drawer dd:has-text("post-a-officer")')
        ok(True,'acknowledge works in a real browser')
        await page.click('.drawer button:has-text("Request footage")'); await page.wait_for_selector('dialog[open]')
        await page.fill('dialog textarea','E2E: suspected tampering near coach 3')
        await page.screenshot(path=SHOTS + '/04_request_form.png')
        await page.click('dialog button[type=submit]')
        await page.wait_for_selector('dialog[open]',state='detached')
        await page.wait_for_selector('.drawer :text("Footage requests (1)")')
        ok(True,'footage request submitted from the drawer')
        rid=await page.evaluate("""async()=>{const t=sessionStorage.getItem('rpf_token');const r=await fetch('/api/requests?status=open',{headers:{Authorization:'Bearer '+t}});return (await r.json())[0].id}""")
        await page.click('.drawer button:has-text("Close")')
        await page.click('.tab:has-text("Requests")'); await page.wait_for_selector('.badge:has-text("submitted")')
        await page.screenshot(path=SHOTS + '/05_requests.png')

        print('CMS side fulfils the request; dashboard should notice by polling')
        vp9=os.path.join(tempfile.gettempdir(),'rpf-vp9.mp4')
        subprocess.run(['ffmpeg','-loglevel','error','-y','-f','lavfi','-i','testsrc=duration=6:size=320x240:rate=15','-f','lavfi','-i','sine=frequency=440:duration=6','-c:v','libvpx-vp9','-b:v','200k','-c:a','libopus','-b:a','32k','-shortest','-movflags','+faststart',vp9],check=True)
        env=dict(os.environ,SAMPLE_FILE=vp9)
        proc=await asyncio.create_subprocess_exec('node','scripts/simulate_cms.js','fulfill',str(rid),cwd=ROOT,env=env,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.STDOUT)
        print('   ',(await proc.communicate())[0].decode().strip())
        await page.wait_for_selector('.toast:has-text("footage")',timeout=15000)
        ok(True,'live toast appeared when CMS delivered footage (poll, no reload)')
        await page.click('.tab:has-text("Footage")'); await page.wait_for_selector('button:has-text("Play")')
        await page.screenshot(path=SHOTS + '/06_footage.png')
        await page.locator('button:has-text("Play")').first.click(); await page.wait_for_selector('dialog[open] video')
        await page.wait_for_function("()=>{const v=document.querySelector('dialog[open] video');return v&&v.readyState>=2&&v.videoWidth>0}",timeout=15000)
        dims=await page.evaluate("()=>{const v=document.querySelector('dialog[open] video');return [v.videoWidth,v.videoHeight,v.duration]}")
        ok(dims[0]==320 and dims[1]==240,f'video really decodes and plays in Chromium ({dims[0]}x{dims[1]}, {dims[2]:.0f}s)')
        await page.evaluate("()=>{const v=document.querySelector('dialog[open] video');v.currentTime=1;v.play()}")
        await page.wait_for_function("()=>document.querySelector('dialog[open] video').currentTime>1.3",timeout=8000)
        ok(True,'playback advances (seek + play)')
        await page.screenshot(path=SHOTS + '/07_player.png')
        await page.click('dialog[open] button:has-text("Close")')
        async with page.expect_download() as dl:
            await page.locator('button:has-text("Save locally")').first.click()
        d=await dl.value; path=await d.path()
        import hashlib; h=hashlib.sha256(open(path,'rb').read()).hexdigest()
        rec=await page.evaluate("""async()=>{const t=sessionStorage.getItem('rpf_token');const r=await fetch('/api/footage',{headers:{Authorization:'Bearer '+t}});return (await r.json())[0].sha256}""")
        ok(h==rec,f'downloaded file hash matches recorded hash ({h[:12]}...)')
        await page.locator('button.btn:text-is("Flag")').first.click(); await page.wait_for_selector('dialog[open]')
        await page.click('dialog button[type=submit]'); await page.wait_for_selector('dialog .err:not(:empty)')
        ok('justification' in (await page.inner_text('dialog .err')),'flag without justification is rejected')
        await page.fill('dialog textarea','E2E: needed as evidence'); await page.screenshot(path=SHOTS + '/08_flag_form.png')
        await page.click('dialog button[type=submit]'); await page.wait_for_selector('dialog[open]',state='detached')
        await page.click('.tab:has-text("Evidence flags")'); await page.wait_for_selector('td:has-text("E2E: needed as evidence")')
        await page.screenshot(path=SHOTS + '/09_flags.png')
        ok(True,'footage flagged and listed under Evidence flags')
        await page.click('.topbar button:has-text("Sign out")'); await page.wait_for_selector('form.login')
        ok(await page.evaluate("sessionStorage.getItem('rpf_token')")is None,'sign out clears the session')

        print('zone admin flow')
        await login(page,'zone1-admin')
        await page.wait_for_selector('table tbody tr')
        ok(await page.locator('.tab').count()==6,'admin has 6 tabs')
        ok(await page.locator('button.btn:text-is("Acknowledge")').count()==0 and await page.locator('button:has-text("New footage request")').count()==0,'no officer action buttons for an admin')
        await page.click('.tab:has-text("Posts overview")'); await page.wait_for_selector('.post-card')
        await page.screenshot(path=SHOTS + '/10_overview.png')
        ok(await page.locator('.post-card').count()>=2,'overview shows post cards')
        await page.click('.tab:has-text("Audit trail")'); await page.wait_for_selector('td .mono')
        await page.screenshot(path=SHOTS + '/11_audit.png')
        txt=await page.inner_text('main'); ok('footage.view' in txt and 'footage.flag' in txt,'audit trail shows the officer\'s view and flag actions')

        print('mobile viewport')
        m=await br.new_context(viewport={'width':390,'height':780}); mp=await m.new_page()
        await login(mp,'post-a-officer'); await mp.wait_for_selector('table tbody tr')
        await mp.screenshot(path=SHOTS + '/12_mobile.png')
        sw=await mp.evaluate("document.documentElement.scrollWidth"); ok(sw<=392,f'no horizontal page scroll on a phone (scrollWidth={sw})')

        # the 401 (wrong password) and 400 (empty justification) are deliberate negative tests above
        real=[e for e in errs if 'favicon' not in e and not ('Failed to load resource' in e and ('401' in e or '400' in e))]
        ok(not real,'no browser console/page errors'+(' -> '+'; '.join(real[:3]) if real else ''))
        await br.close()
    print('\nFAILED: '+str(problems) if problems else '\nALL CHECKS PASSED')
    sys.exit(1 if problems else 0)
asyncio.run(main())
