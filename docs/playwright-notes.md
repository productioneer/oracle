# Playwright Implementation Notes

Library-specific details for Playwright. **This is the recommended library** for Oracle browser automation.

---

## Why Playwright

- **Built-in auto-waiting**: Every action automatically waits for element to be visible, stable, and actionable
- **Better API**: Cleaner locator-based API with `setInputFiles()` for uploads
- **Network idle**: Native `waitForLoadState('networkidle')`
- **Cross-browser**: Chromium, Firefox, WebKit (if ever needed)
- **Multi-language**: JS, Python, Java, C# (official support)

---

## File Uploads

### Standard Method: setInputFiles()

```javascript
// Single file
await page.locator('input[type=file]').setInputFiles('./path/to/file.pdf');

// Multiple files
await page.locator('#file-upload').setInputFiles([
  './file1.txt',
  './file2.txt'
]);

// With absolute path (recommended for reliability)
const path = require('path');
await page.locator('input[type=file]').setInputFiles(
  path.join(__dirname, 'myfile.pdf')
);

// Clear files
await page.locator('input[type=file]').setInputFiles([]);
```

### From Buffer (dynamic content)

```javascript
await page.locator('input[type=file]').setInputFiles({
  name: 'dynamic.txt',
  mimeType: 'text/plain',
  buffer: Buffer.from('File content here')
});
```

### For Hidden Inputs: FileChooser

```javascript
const fileChooserPromise = page.waitForEvent('filechooser');
await page.locator('#upload-button').click();
const fileChooser = await fileChooserPromise;
await fileChooser.setFiles('/path/to/file.pdf');
```

---

## Network Idle Detection

### waitForLoadState()

```javascript
// Wait until no network requests for 500ms
await page.waitForLoadState('networkidle');

// With custom timeout
await page.waitForLoadState('networkidle', { timeout: 10000 });
```

**Load states:**
- `'load'` - wait for load event
- `'domcontentloaded'` - wait for DOMContentLoaded event
- `'networkidle'` - wait until ≤2 requests for 500ms

### During Navigation

```javascript
// Wait for network idle after navigation
await page.goto('https://chatgpt.com/', { waitUntil: 'networkidle' });

// Or separately
await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded' });
await page.waitForLoadState('networkidle');
```

### After Actions

```javascript
// After file upload
await page.locator('input[type=file]').setInputFiles('./file.pdf');
await page.waitForLoadState('networkidle');

// After clicking submit
await page.locator('#submit').click();
await page.waitForLoadState('networkidle');
```

---

## Common Patterns

### Locators (auto-waiting)

```javascript
// By test ID
await page.locator('[data-testid="send-button"]').click();

// By role
await page.getByRole('button', { name: 'Send' }).click();

// By text
await page.getByText('New chat').click();

// By placeholder
await page.getByPlaceholder('Ask anything').fill('Hello');

// By label
await page.getByLabel('Upload file').setInputFiles('./file.pdf');
```

### Type into ContentEditable (ProseMirror)

```javascript
// Focus and type with delays
await page.locator('#prompt-textarea').click();
await page.keyboard.type('Your message here', { delay: 30 });

// Or use pressSequentially for more control
await page.locator('#prompt-textarea').pressSequentially('Your message', { delay: 50 });
```

### Wait for Text

```javascript
// Wait for element with text
await page.locator('text=Pro thinking').waitFor();

// Wait for text to appear anywhere
await page.waitForSelector('text=Response complete');

// Expect with auto-retry
await expect(page.locator('.response')).toContainText('Expected content');
```

### Wait for Element State

```javascript
// Wait for visible
await page.locator(selector).waitFor({ state: 'visible' });

// Wait for hidden/removed
await page.locator(selector).waitFor({ state: 'hidden' });

// Wait for attached to DOM
await page.locator(selector).waitFor({ state: 'attached' });
```

---

## Migration from Puppeteer

| Puppeteer | Playwright |
|-----------|------------|
| `page.$(selector)` | `page.locator(selector)` |
| `page.waitForSelector(sel)` | `page.locator(sel).waitFor()` (or just use locator - auto-waits) |
| `page.click(selector)` | `page.locator(selector).click()` |
| `page.type(sel, text)` | `page.locator(sel).fill(text)` or `page.keyboard.type(text)` |
| `element.uploadFile(path)` | `locator.setInputFiles(path)` |
| `page.waitForNetworkIdle()` | `page.waitForLoadState('networkidle')` |
| `page.evaluate(fn)` | `page.evaluate(fn)` (same) |
| `page.waitForFunction(fn)` | `page.waitForFunction(fn)` (same) |
