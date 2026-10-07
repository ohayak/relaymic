# Third-party code in the extension

## qrcodegen.js

The popup and the approval window (`pair.html?show=qr`) draw the pairing QR code with Project Nayuki's
"QR Code generator library", used unchanged.

| | |
|---|---|
| Project | QR Code generator library, https://www.nayuki.io/page/qr-code-generator-library |
| Source | https://github.com/nayuki/QR-Code-generator, tag `v1.8.0`, file `typescript-javascript/qrcodegen.ts` |
| Source SHA-256 | `c4749095a91bf9696e3a303998b9905e467094f53041e64393e65e6d887737fd` |
| Built with | TypeScript 5.6.3: `tsc --target ES2018 --strict --outDir out qrcodegen.ts` (the file renamed from the tag's path, nothing else changed) |
| `qrcodegen.js` SHA-256 | `6e200897a80ff15a652a5d601667856d807cec60cfc81a3a351305d69cc9dbbd` |
| License | MIT, below; the same notice heads `qrcodegen.js` |

The compiled file is a classic script that defines one global, `qrcodegen`. Nothing else in it runs on load, and
it reaches no network, storage or extension API. The popup loads it only when a pairing panel opens.

To check the file, or to rebuild it:

```sh
curl -sSLO https://raw.githubusercontent.com/nayuki/QR-Code-generator/v1.8.0/typescript-javascript/qrcodegen.ts
shasum -a 256 qrcodegen.ts            # the source SHA-256 above
npx -y typescript@5.6.3 tsc --target ES2018 --strict --outDir out qrcodegen.ts
shasum -a 256 out/qrcodegen.js        # the qrcodegen.js SHA-256 above
```

### License

Copyright © 2022 Project Nayuki. (MIT License)
https://www.nayuki.io/page/qr-code-generator-library

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

* The above copyright notice and this permission notice shall be included in
  all copies or substantial portions of the Software.

* The Software is provided "as is", without warranty of any kind, express or
  implied, including but not limited to the warranties of merchantability,
  fitness for a particular purpose and noninfringement. In no event shall the
  authors or copyright holders be liable for any claim, damages or other
  liability, whether in an action of contract, tort or otherwise, arising from,
  out of or in connection with the Software or the use or other dealings in the
  Software.
