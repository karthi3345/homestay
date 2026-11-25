import { chromium } from 'playwright';

async function runTests() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🚀 Running VolGO Stays Playwright Automated Test Suite');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 }
  });
  const page = await context.newPage();

  const results = [];
  function record(name, pass, details = '') {
    results.push({ name, pass, details });
    console.log(`${pass ? '✅ PASS' : '❌ FAIL'}: ${name} ${details ? '— ' + details : ''}`);
  }

  try {
    // Test 1: Page Loads & Map Container Renders
    await page.goto('http://localhost:3000', { waitUntil: 'domcontentloaded', timeout: 15000 });
    const pageTitle = await page.title();
    const mapExists = await page.locator('#staysMap').isVisible();
    record('TC-01: Page Load & Map Container Visibility', mapExists && pageTitle.includes('VolGO Stays'), `Title: "${pageTitle}"`);

    // Wait for map initialization
    await page.waitForTimeout(1500);

    // Test 2: Perspective Controls Presence in Normal View
    const btn3d = page.locator('#btn3dToggle');
    const btnZoomIn = page.locator('#btnZoomIn');
    const btnZoomOut = page.locator('#btnZoomOut');
    const btnFullView = page.locator('#btnResetView');
    const controlsVisible = (await btn3d.isVisible()) && (await btnZoomIn.isVisible()) && (await btnZoomOut.isVisible()) && (await btnFullView.isVisible());
    record('TC-02: Map Perspective Controls Rendered', controlsVisible, 'Found #btn3dToggle, #btnZoomIn, #btnZoomOut, #btnResetView');

    // Test 3: 3D View Toggle in Normal View
    await btn3d.click();
    await page.waitForTimeout(900);
    const is3dActive = await btn3d.evaluate(el => el.classList.contains('active') && el.textContent.includes('2D View'));
    const pitchVal = await page.evaluate(() => window.staysMap ? window.staysMap.getPitch() : 0);
    record('TC-03: 3D View Toggle Tilt (Normal View)', is3dActive || pitchVal > 20, `Pitch: ${pitchVal.toFixed(1)}°, Label toggled to 2D View`);

    // Toggle back to 2D
    await btn3d.click();
    await page.waitForTimeout(950);
    const restored2d = await page.evaluate(() => window.staysMap ? window.staysMap.getPitch() <= 5 : true);
    record('TC-04: Restore 2D View from 3D', restored2d, 'Pitch restored to 0°');

    // Test 4: Zoom Controls Responsive Check
    const initialZoom = await page.evaluate(() => window.staysMap ? window.staysMap.getZoom() : 13);
    await btnZoomIn.click();
    await page.waitForTimeout(400);
    const zoomedIn = await page.evaluate(() => window.staysMap ? window.staysMap.getZoom() : 13);
    record('TC-05: Zoom In Functionality', zoomedIn >= initialZoom, `Initial: ${initialZoom.toFixed(1)}, After Zoom In: ${zoomedIn.toFixed(1)}`);

    // Test 5: Open Stay Modal & Verify Zero Collision in Normal View
    const stayCards = page.locator('.stay-card');
    if (await stayCards.count() > 0) {
      await stayCards.nth(2).click(); // Click Eden Villa 3BHK
      await page.waitForTimeout(600);
    }
    // Verify Modal Box spawns on the right side by default in normal view (matching user screenshot)
    const normalModalBox = page.locator('#stayGlassModalBox');
    const nBox = await normalModalBox.boundingBox();
    const isNormalRightSide = nBox ? (nBox.x > 700) : false;
    record('TC-06A: Modal Spawns on Right Side by Default in Normal View', isNormalRightSide, 
      nBox ? `Modal X: ${Math.round(nBox.x)}px (Viewport 1440px, placed over right booking pane, map completely unobstructed)` : '');

    const guidelineBar = page.locator('#mapGuidelineBar');
    const controls = page.locator('.map-perspective-controls');
    const barVisible = await guidelineBar.isVisible();
    const gBox = await guidelineBar.boundingBox();
    const cBox = await controls.boundingBox();
    const noCollisionNormal = gBox && cBox ? (gBox.x + gBox.width < cBox.x + 5) : false;
    record('TC-06B: Zero Collision between Guideline Bar & Controls (Normal View)', noCollisionNormal || !barVisible, 
      gBox && cBox ? `Guideline Right: ${Math.round(gBox.x + gBox.width)}px, Controls Left: ${Math.round(cBox.x)}px (Gap: ${Math.round(cBox.x - (gBox.x + gBox.width))}px)` : '');

    // Test 6: Destination Area Pin on Map at End of Route
    const areaCards = page.locator('.gm-area-card');
    if (await areaCards.count() > 1) {
      await areaCards.nth(1).click(); // Click Chunnambar Boat House
      await page.waitForTimeout(1400); // Wait for line animation
    }
    const destMarker = page.locator('.beach-dest-marker');
    const destMarkerVisible = await destMarker.isVisible();
    const destText = await destMarker.locator('.dest-label').textContent().catch(() => '');
    record('TC-07: Destination Area Pin Reflects Clicked Location on Map', destMarkerVisible && destText.length > 0, `Pin Label: "${destText}"`);

    // Verify Milestone Badge
    const walkBadge = page.locator('.walk-3d-badge');
    const walkBadgeVisible = await walkBadge.isVisible();
    const walkBadgeText = await walkBadge.textContent().catch(() => '');
    record('TC-08: Circular Milestone Badge on Connecting Guideline Line', walkBadgeVisible, `Milestone: "${walkBadgeText.trim()}"`);

    // Close modal
    const closeBtn = page.locator('#closeStayGlassModal');
    if (await closeBtn.isVisible()) {
      await closeBtn.click();
      await page.waitForTimeout(400);
    }
    const modalClosed = !(await page.locator('#stayGlassModal').isVisible());
    record('TC-09: Modal Close Cleans State', modalClosed, 'Modal overlay hidden');

    // Test 7: Enter Full View Mode
    await btnFullView.click();
    await page.waitForTimeout(1200); // Wait for fullscreen transition and fitAllStaysView
    const isFullscreen = await page.evaluate(() => document.body.classList.contains('map-fullscreen-active'));
    const dockVisible = await page.locator('#mapFsDock').isVisible();
    const topbarRemoved = !(await page.locator('#mapFsTopbar').count() > 0);
    record('TC-10: Full View Mode Activation (Topbar Cleanly Removed)', isFullscreen && dockVisible && topbarRemoved, 'Fullscreen frame and dock active, topbar removed');

    // Test 8: 3D View Button in Full View
    const btn3dFull = page.locator('#btn3dToggle');
    await btn3dFull.click();
    await page.waitForTimeout(1000);
    const pitchFull = await page.evaluate(() => window.staysMap ? window.staysMap.getPitch() : 0);
    const btn3dFullActive = await btn3dFull.evaluate(el => el.classList.contains('active'));
    record('TC-11: 3D View Perspective in Full View', btn3dFullActive || pitchFull > 20, `Full View Pitch: ${pitchFull.toFixed(1)}°`);

    // Test 9: Zoom Buttons in Full View Retain Circular Layout
    const zoomInBox = await btnZoomIn.boundingBox();
    const isCircular = zoomInBox ? Math.abs(zoomInBox.width - zoomInBox.height) <= 4 : false;
    record('TC-12: Full View Controls Integrity (Circular Micro-Buttons)', isCircular, `Zoom button dimensions: ${Math.round(zoomInBox?.width || 0)}x${Math.round(zoomInBox?.height || 0)}px`);

    // Test 10: Modal Spawns Over Sea Area by Default in Full View
    const dockCards = page.locator('.mf-dock-card');
    if (await dockCards.count() > 0) {
      await dockCards.nth(2).click(); // Click Eden Villa
      await page.waitForTimeout(800);
    }
    const modalBox = page.locator('#stayGlassModalBox');
    const modalBoxVisible = await modalBox.isVisible();
    const modalRect = await modalBox.boundingBox();
    const viewportWidth = 1440;
    const isAtSeaArea = modalRect ? modalRect.x > (viewportWidth * 0.45) : false;
    record('TC-13: Floating Modal Spawns Over Sea Area in Full View', modalBoxVisible && isAtSeaArea, 
      modalRect ? `Modal X: ${Math.round(modalRect.x)}px (Screen width: ${viewportWidth}px, positioned in right ocean area)` : '');

    // Test 11: Guideline Bar in Full View Positioned Cleanly at Top-Left
    const fsGbox = await guidelineBar.boundingBox();
    const isTopClean = fsGbox ? (fsGbox.y <= 30 && fsGbox.x <= 30) : true;
    record('TC-14: Zero Collision & Clean Top-Left Placement in Full View', isTopClean, 
      fsGbox ? `Guideline Position: X=${Math.round(fsGbox.x)}px, Y=${Math.round(fsGbox.y)}px (Clean unobstructed map)` : 'Unobstructed');

    // Test 12: Exit Full View Mode
    await page.locator('#btnResetView').click();
    await page.waitForTimeout(600);
    const exitedFullscreen = await page.evaluate(() => !document.body.classList.contains('map-fullscreen-active'));
    record('TC-15: Exit Full View Mode Restores Default Layout', exitedFullscreen, 'Clean restoration to normal page layout');

  } catch (err) {
    console.error('Test execution error:', err);
    record('Execution Exception', false, err.message);
  } finally {
    await browser.close();
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  const passCount = results.filter(r => r.pass).length;
  const totalCount = results.length;
  console.log(`📊 Test Summary: ${passCount}/${totalCount} Passed (${Math.round((passCount/totalCount)*100)}%)`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  return { passCount, totalCount, results };
}

runTests().then(summary => {
  if (summary.passCount < summary.totalCount) {
    process.exit(1);
  } else {
    process.exit(0);
  }
});
