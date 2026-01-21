# Puppeteer Implementation Notes

Library-specific details for Puppeteer. **Note: Migration to Playwright is planned** (see oracle-improvements.md).

This document is kept for reference in case Puppeteer is still needed.

---

## File Uploads

### Standard Method: uploadFile()

```javascript
// Wait for file input
await page.waitForSelector('input[type=file]');
const fileInput = await page.$('input[type=file]');

// Upload file (use absolute path)
await fileInput.uploadFile('/absolute/path/to/file.pdf');
```

**Notes:**
- Paths must be absolute for remote Chrome environments
- Does NOT validate if file exists
- Relative paths resolve from current working directory

### For Hidden/Custom File Inputs: FileChooser

When the file input is hidden or triggered by a custom button:

```javascript
const [fileChooser] = await Promise.all([
  page.waitForFileChooser(),
  page.click('#customUploadButton')  // triggers the file dialog
]);

await fileChooser.accept(['/path/to/file.jpg']);
```

### DataTransfer Injection (fallback)

When native methods fail, inject via DataTransfer API:

```javascript
await page.evaluate((selector, base64Content, mimeType, fileName) => {
  const fileInput = document.querySelector(selector);

  const byteCharacters = atob(base64Content);
  const byteNumbers = new Array(byteCharacters.length);
  for (let i = 0; i < byteCharacters.length; i++) {
    byteNumbers[i] = byteCharacters.charCodeAt(i);
  }
  const byteArray = new Uint8Array(byteNumbers);
  const blob = new Blob([byteArray], { type: mimeType });
  const file = new File([blob], fileName, { type: mimeType, lastModified: Date.now() });

  const dataTransfer = new DataTransfer();
  dataTransfer.items.add(file);
  fileInput.files = dataTransfer.files;

  // Dispatch change event
  fileInput.dispatchEvent(new Event('change', { bubbles: true }));
}, selector, base64Content, mimeType, fileName);
```

---

## Network Idle Detection

### waitForNetworkIdle()

Wait until no network requests for a specified duration:

```javascript
// Wait until no requests for 500ms (default)
await page.waitForNetworkIdle();

// Custom idle time
await page.waitForNetworkIdle({ idleTime: 750 });

// With timeout
await page.waitForNetworkIdle({ idleTime: 500, timeout: 30000 });
```

**Use cases:**
- After file uploads to confirm completion
- After page navigation to ensure all resources loaded
- Before taking screenshots

### During Navigation

```javascript
// Option 1: networkidle0 (no connections for 500ms)
await page.goto(url, { waitUntil: 'networkidle0' });

// Option 2: Faster load + manual idle wait
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForNetworkIdle({ idleTime: 250 });
```

---

## Common Patterns

### Wait for Element + Click

```javascript
await page.waitForSelector(selector);
await page.click(selector);
```

### Type into Input

```javascript
await page.waitForSelector(selector);
await page.click(selector);
await page.keyboard.type('text', { delay: 30 });
```

### Wait for Text to Appear

```javascript
await page.waitForFunction(
  (sel, text) => {
    const el = document.querySelector(sel);
    return el && el.innerText.includes(text);
  },
  {},
  selector,
  expectedText
);
```
