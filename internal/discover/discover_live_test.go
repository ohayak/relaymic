package discover

import "testing"

// Live-environment probe: run manually with go test -run TestLiveDiscover -v.
func TestLiveDiscover(t *testing.T) {
	if testing.Short() {
		t.Skip("live probe")
	}
	peers, err := tailnetPeers()
	t.Logf("peers: %v err: %v", peers, err)
	found, err := Receivers()
	t.Logf("found: %v err: %v", found, err)
}

func TestLiveSelfName(t *testing.T) {
	if testing.Short() {
		t.Skip("live probe")
	}
	t.Logf("DNS: %q  CLI: %q", selfNameFromDNS(), selfNameFromCLI())
}
