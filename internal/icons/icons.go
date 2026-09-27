// Package icons holds the icon tile the Go programs show: the favicons the
// receiver serves for its pages and the sender GUI's window icon are the
// same picture, so it lives once. macos/icons.py derives the files from icons/.
package icons

import (
	"embed"
	"io/fs"
)

//go:embed favicon-32.png favicon-96.png
var files embed.FS

// FS holds favicon-32.png and favicon-96.png, to serve at the site root.
func FS() fs.FS { return files }

// Favicon96 is the 96px tile, for a window icon.
//
//go:embed favicon-96.png
var Favicon96 []byte
