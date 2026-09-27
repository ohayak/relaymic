// sender-gui is the native sender's graphical front end: double-click, pick a
// microphone, press Start.
//
// The core logic is all in internal/sender; this only does three things:
// draw the status, remember the choices, and make Chinese text render.
package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"

	"fyne.io/fyne/v2"
	"fyne.io/fyne/v2/app"
	"fyne.io/fyne/v2/container"
	"fyne.io/fyne/v2/widget"

	"github.com/hueshu/relaymic/internal/icons"
	"github.com/hueshu/relaymic/internal/sender"
)

// config is the user's remembered choices, stored under the user config directory.
type config struct {
	Target string `json:"target"`
	Device string `json:"device"`
	// Stored inverted: the zero value means "hear the return path", so old config
	// files without this field default to on.
	Mute bool `json:"mute"`
}

// shortHost shortens https://100.x.y.z:7420 to 100.x.y.z, to keep the status line short.
func shortHost(target string) string {
	t := strings.TrimPrefix(strings.TrimPrefix(target, "https://"), "http://")
	if i := strings.Index(t, ":"); i > 0 {
		t = t[:i]
	}
	return t
}

func configPath() string {
	dir, err := os.UserConfigDir()
	if err != nil {
		return ""
	}
	return filepath.Join(dir, "remotevisio", "sender.json")
}

func loadConfig() config {
	var c config
	p := configPath()
	if p == "" {
		return c
	}
	data, err := os.ReadFile(p)
	if err != nil {
		return c
	}
	_ = json.Unmarshal(data, &c)
	return c
}

func saveConfig(c config) {
	p := configPath()
	if p == "" {
		return
	}
	_ = os.MkdirAll(filepath.Dir(p), 0o755)
	data, _ := json.Marshal(c)
	_ = os.WriteFile(p, data, 0o644)
}

// useSystemCJKFont makes Fyne use a Chinese font shipped with the system.
// Fyne's bundled font has no Chinese glyphs; without this the UI is all tofu boxes.
//
// Only a single .ttf works: FYNE_FONT rejects .ttc collections with
// "collections not allowed" and then crashes on a nil pointer while rendering.
func useSystemCJKFont() {
	candidates := []string{
		`C:\Windows\Fonts\simhei.ttf`,                          // SimHei, present on every Windows version
		`C:\Windows\Fonts\Deng.ttf`,                            // DengXian, Win10+
		"/System/Library/Fonts/Supplemental/Arial Unicode.ttf", // macOS (for development testing)
	}
	for _, p := range candidates {
		if _, err := os.Stat(p); err == nil {
			os.Setenv("FYNE_FONT", p)
			return
		}
	}
}

func main() {
	useSystemCJKFont()

	a := app.NewWithID("com.remotevisio.sender")
	// Window and taskbar icon; the .exe file icon is added by the build workflow from icons/RemoteVisio.ico.
	a.SetIcon(fyne.NewStaticResource("favicon-96.png", icons.Favicon96))
	w := a.NewWindow("Remote Visio")
	w.Resize(fyne.NewSize(380, 300))

	cfg := loadConfig()

	// By default every receiver in the tailnet is auto-discovered, so the UI needs
	// no address at all. The manual box is only a supplement (for machines outside
	// the tailnet).
	targetEntry := widget.NewMultiLineEntry()
	targetEntry.SetMinRowsVisible(2)
	targetEntry.SetPlaceHolder("Auto-discovery is on; leave this empty\n(add addresses outside the tailnet here, one per line)")
	targetEntry.SetText(cfg.Target)

	mics, _ := sender.ListMics()
	micSelect := widget.NewSelect(mics, nil)
	if cfg.Device != "" {
		micSelect.SetSelected(cfg.Device)
	} else if len(mics) > 0 {
		micSelect.SetSelectedIndex(0)
	}

	hearCheck := widget.NewCheck("Hear the remote Mac (headphones recommended)", nil)
	hearCheck.SetChecked(!cfg.Mute)

	status := widget.NewLabel("Not connected (press Start to auto-discover receivers)")
	levelBar := widget.NewProgressBar()
	levelBar.TextFormatter = func() string { return "" }

	var eng *sender.Engine
	var toggle *widget.Button
	toggle = widget.NewButton("Start talking", func() {
		if eng != nil {
			eng.Stop()
			eng = nil
			toggle.SetText("Start talking")
			levelBar.SetValue(0)
			return
		}

		cfg.Target = targetEntry.Text
		cfg.Device = micSelect.Selected
		cfg.Mute = !hearCheck.Checked
		saveConfig(cfg)

		targets := []string{}
		for _, t := range strings.Split(cfg.Target, "\n") {
			if t = strings.TrimSpace(t); t != "" {
				targets = append(targets, t)
			}
		}
		e := sender.New(sender.Config{Targets: targets, Discover: true, Device: cfg.Device, Speaker: !cfg.Mute})
		states := map[string]string{}
		order := []string{}
		e.OnState = func(target, s string) {
			fyne.Do(func() {
				if _, seen := states[target]; !seen {
					order = append(order, target) // auto-discovered targets are listed in order of appearance
				}
				states[target] = s
				lines := make([]string, 0, len(order))
				for _, t := range order {
					lines = append(lines, shortHost(t)+"  "+states[t])
				}
				status.SetText(strings.Join(lines, "\n"))
			})
		}
		e.OnLevel = func(db float64) {
			// below -60dBFS counts as silence, 0dBFS is full scale
			v := (db + 60) / 60
			if v < 0 {
				v = 0
			}
			if v > 1 {
				v = 1
			}
			fyne.Do(func() { levelBar.SetValue(v) })
		}
		if err := e.Start(); err != nil {
			status.SetText("Error: " + err.Error())
			return
		}
		eng = e
		toggle.SetText("Stop")
	})
	toggle.Importance = widget.HighImportance

	w.SetContent(container.NewVBox(
		widget.NewForm(
			widget.NewFormItem("Receiver", targetEntry),
			widget.NewFormItem("Microphone", micSelect),
		),
		hearCheck,
		toggle,
		levelBar,
		status,
	))

	w.SetCloseIntercept(func() {
		if eng != nil {
			eng.Stop()
		}
		a.Quit()
	})
	w.ShowAndRun()
}
