// Package web embeds the sender page so the receiver builds into a single binary.
package web

import (
	"embed"
	"io/fs"
)

//go:embed index.html i18n.js
var files embed.FS

// FS returns a filesystem that can be handed directly to http.FileServer.
func FS() fs.FS { return files }

// MonitorHTML is the receiver's own monitor page. It does not share the sender
// page's FileServer: that one is mounted at the root, and any file placed in
// it would be exposed as a sender resource. It does load /i18n.js from there,
// which is shared on purpose.
//
//go:embed monitor.html
var MonitorHTML []byte
