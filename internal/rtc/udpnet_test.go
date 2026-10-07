package rtc

import (
	"errors"
	"net"
	"net/netip"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/pion/ice/v4"
	"github.com/pion/logging"
	"github.com/pion/transport/v4"
	"github.com/pion/transport/v4/stdnet"
	"github.com/pion/webrtc/v4"
)

// holdNet is the network of a Mac whose VPN tunnel or network filter holds
// some packets: a write to an address hold picks waits until the socket's
// write deadline, or, with none, until release closes, as the sender's
// connectivity checks to one of its IPv6 addresses did on a managed Mac.
type holdNet struct {
	transport.Net
	hold    func(net.Addr) bool
	release chan struct{}
	held    atomic.Int64
}

func newHoldNet(t *testing.T, hold func(net.Addr) bool) *holdNet {
	inner, err := stdnet.NewNet()
	if err != nil {
		t.Fatal(err)
	}
	n := &holdNet{Net: inner, hold: hold, release: make(chan struct{})}
	t.Cleanup(func() { close(n.release) }) // frees the writes still held, so the connections can close
	return n
}

func (n *holdNet) ListenPacket(network, address string) (net.PacketConn, error) {
	c, err := n.Net.ListenPacket(network, address)
	if err != nil {
		return nil, err
	}
	if u, ok := c.(transport.UDPConn); ok {
		return &holdUDP{UDPConn: u, n: n}, nil
	}
	return c, nil
}

func (n *holdNet) ListenUDP(network string, laddr *net.UDPAddr) (transport.UDPConn, error) {
	c, err := n.Net.ListenUDP(network, laddr)
	if err != nil || (laddr != nil && laddr.IP.IsMulticast()) {
		return c, err // multicast DNS: see boundedNet.ListenUDP
	}
	return &holdUDP{UDPConn: c, n: n}, nil
}

type holdUDP struct {
	transport.UDPConn
	n        *holdNet
	mu       sync.Mutex
	deadline time.Time
}

func (c *holdUDP) SetWriteDeadline(t time.Time) error {
	c.mu.Lock()
	c.deadline = t
	c.mu.Unlock()
	return c.UDPConn.SetWriteDeadline(t)
}

func (c *holdUDP) SetDeadline(t time.Time) error {
	c.mu.Lock()
	c.deadline = t
	c.mu.Unlock()
	return c.UDPConn.SetDeadline(t)
}

// wait holds a write to a held address, like a socket that never becomes
// writable: until the write deadline, or for good without one.
func (c *holdUDP) wait(addr net.Addr) error {
	if !c.n.hold(addr) {
		return nil
	}
	c.n.held.Add(1)
	c.mu.Lock()
	d := c.deadline
	c.mu.Unlock()
	var timeout <-chan time.Time
	if !d.IsZero() {
		timeout = time.After(time.Until(d))
	}
	select {
	case <-timeout:
		return os.ErrDeadlineExceeded
	case <-c.n.release:
		return net.ErrClosed
	}
}

func (c *holdUDP) WriteTo(b []byte, addr net.Addr) (int, error) {
	if err := c.wait(addr); err != nil {
		return 0, err
	}
	return c.UDPConn.WriteTo(b, addr)
}

func (c *holdUDP) WriteToUDP(b []byte, addr *net.UDPAddr) (int, error) {
	if err := c.wait(addr); err != nil {
		return 0, err
	}
	return c.UDPConn.WriteToUDP(b, addr)
}

func (c *holdUDP) ReadFromUDPAddrPort(b []byte) (int, netip.AddrPort, error) {
	return c.UDPConn.(addrPortConn).ReadFromUDPAddrPort(b)
}

func (c *holdUDP) WriteToUDPAddrPort(b []byte, addr netip.AddrPort) (int, error) {
	if err := c.wait(net.UDPAddrFromAddrPort(addr)); err != nil {
		return 0, err
	}
	return c.UDPConn.(addrPortConn).WriteToUDPAddrPort(b, addr)
}

func isIPv6(a net.Addr) bool {
	u, ok := a.(*net.UDPAddr)
	return ok && u.IP.To4() == nil
}

// heldOffer is the sender's offer, and the receiver's network holding every
// write to an IPv6 address; the test is skipped on a machine without IPv6
// (nothing would be held there).
func heldOffer(t *testing.T, wait time.Duration) (*holdNet, *webrtc.PeerConnection) {
	t.Helper()
	hn := newHoldNet(t, isIPv6)
	defer func(n func() (transport.Net, error), w time.Duration) {
		t.Cleanup(func() { newNet, udpWriteWait = n, w })
	}(newNet, udpWriteWait)
	newNet = func() (transport.Net, error) { return hn, nil }
	udpWriteWait = wait
	pc, _ := senderPeer(t, webrtc.RTPTransceiverDirectionSendrecv)
	t.Cleanup(func() { pc.Close() })
	if !strings.Contains(pc.LocalDescription().SDP, " typ host") || !hasIPv6Candidate(pc.LocalDescription().SDP) {
		t.Skip("this machine offers no IPv6 candidate: nothing to hold")
	}
	return hn, pc
}

func hasIPv6Candidate(sdp string) bool {
	for _, line := range strings.Split(sdp, "\n") {
		f := strings.Fields(line)
		if strings.HasPrefix(line, "a=candidate:") && len(f) > 5 && strings.Contains(f[4], ":") {
			return true
		}
	}
	return false
}

// Without the bound, a held write stops the ICE agent: the answer cannot list
// its candidates. Answer must say so in describeWait, not wait for good (the
// stuck answers that kept a sender on "Connecting").
func TestHeldWriteWithoutBoundFailsTheAnswerInTime(t *testing.T) {
	hn, pc := heldOffer(t, 0)
	r := New(nil)
	r.SetICEServers(nil)
	defer r.Close()
	start := time.Now()
	done := make(chan error, 1)
	go func() { _, err := r.Answer(*pc.LocalDescription(), true); done <- err }()
	select {
	case err := <-done:
		if err == nil || !strings.Contains(err.Error(), "stopped answering") {
			t.Fatalf("with its agent stopped the answer must fail as such, got %v (held writes: %d)", err, hn.held.Load())
		}
	case <-time.After(gatherWait + describeWait + 5*time.Second):
		t.Fatalf("Answer still waiting after %v: a stopped agent holds it for good", time.Since(start))
	}
	if hn.held.Load() == 0 {
		t.Fatal("no write was held: the test did not reproduce the stopped agent")
	}
}

// With the bound, a held write fails like a lost packet: the answer comes at
// once and the sender connects over the address pairs that work.
func TestHeldWriteIsBoundedAndTheSenderConnects(t *testing.T) {
	hn, pc := heldOffer(t, udpWriteWait)
	connected := make(chan struct{})
	var once sync.Once
	r := New(func(s webrtc.PeerConnectionState) {
		if s == webrtc.PeerConnectionStateConnected {
			once.Do(func() { close(connected) })
		}
	})
	r.SetICEServers(nil)
	defer r.Close()
	start := time.Now()
	answer, err := r.Answer(*pc.LocalDescription(), true)
	if err != nil {
		t.Fatalf("Answer: %v", err)
	}
	if took := time.Since(start); took > 3*time.Second {
		t.Errorf("Answer took %v with held writes; it should not notice them", took)
	}
	if err := pc.SetRemoteDescription(*answer); err != nil {
		t.Fatal(err)
	}
	select {
	case <-connected:
	case <-time.After(15 * time.Second):
		t.Fatalf("the sender did not connect over the pairs that work (held writes: %d)", hn.held.Load())
	}
	if hn.held.Load() == 0 {
		t.Fatal("no write was held: the test proved nothing")
	}
}

// A current connection whose agent stops after it was answered (its writes
// held from then on) must not hold the next sender's answer: the old
// connection is closed in the background.
func TestStuckPreviousConnectionDoesNotHoldTheNextAnswer(t *testing.T) {
	var stuck atomic.Bool
	firstAddrs := map[string]bool{}
	var mu sync.Mutex
	key := func(ip net.IP, port int) string { return ip.String() + "|" + strconv.Itoa(port) }
	hn := newHoldNet(t, func(a net.Addr) bool {
		u, ok := a.(*net.UDPAddr)
		if !ok || !stuck.Load() {
			return false
		}
		mu.Lock()
		defer mu.Unlock()
		return firstAddrs[key(u.IP, u.Port)]
	})
	defer func(n func() (transport.Net, error), w time.Duration) { newNet, udpWriteWait = n, w }(newNet, udpWriteWait)
	newNet = func() (transport.Net, error) { return hn, nil }
	udpWriteWait = 0 // unbounded: the first connection's agent really stops

	first, _ := senderPeer(t, webrtc.RTPTransceiverDirectionSendrecv)
	defer first.Close()
	for _, line := range strings.Split(first.LocalDescription().SDP, "\n") {
		f := strings.Fields(line)
		if strings.HasPrefix(line, "a=candidate:") && len(f) > 5 {
			if port, err := strconv.Atoi(f[5]); err == nil && net.ParseIP(f[4]) != nil {
				firstAddrs[key(net.ParseIP(f[4]), port)] = true
			}
		}
	}
	r := New(nil)
	r.SetICEServers(nil)
	defer r.Close()
	if _, err := r.Answer(*first.LocalDescription(), true); err != nil {
		t.Fatalf("first answer: %v", err)
	}
	// That sender never takes the answer, so the receiver keeps checking
	// its addresses; from now on those checks are held, and its agent stops.
	stuck.Store(true)
	for end := time.Now().Add(5 * time.Second); hn.held.Load() == 0; time.Sleep(20 * time.Millisecond) {
		if time.Now().After(end) {
			t.Fatal("no check to the first sender was held")
		}
	}

	second, _ := senderPeer(t, webrtc.RTPTransceiverDirectionSendrecv)
	defer second.Close()
	start := time.Now()
	done := make(chan error, 1)
	go func() { _, err := r.Answer(*second.LocalDescription(), true); done <- err }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("the next answer must not depend on the stuck connection: %v", err)
		}
	case <-time.After(gatherWait + describeWait + 5*time.Second):
		t.Fatalf("the next answer is still waiting after %v: the stuck connection holds it", time.Since(start))
	}
}

// An address no write ever reached is skipped for maxStallSkip from its
// first timeout. To one that worked, one timed-out write costs that packet
// only; the second in a row makes the next ones fail at once for stallSkip,
// twice that on each stall in a row, up to maxStallSkip. After each stall the
// address gets one bounded try, whose timeout stalls it again. A write that
// goes out starts it over, and other addresses are never affected.
func TestBoundedUDPSkipsAStalledAddress(t *testing.T) {
	defer func(s, m time.Duration) { stallSkip, maxStallSkip = s, m }(stallSkip, maxStallSkip)
	stallSkip, maxStallSkip = 120*time.Millisecond, 300*time.Millisecond
	never := &net.UDPAddr{IP: net.ParseIP("2001:db8::1"), Port: 9}
	worked := &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 9}
	var holding atomic.Value
	holding.Store("")
	hn := newHoldNet(t, func(a net.Addr) bool { return a.String() == holding.Load() })
	inner, err := hn.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	defer inner.Close()
	c := newBoundedUDP(inner, 25*time.Millisecond)
	timedOut := func(addr *net.UDPAddr, what string) {
		t.Helper()
		start := time.Now()
		if _, err := c.WriteTo([]byte("x"), addr); !errors.Is(err, os.ErrDeadlineExceeded) {
			t.Fatalf("%s: a held write must time out, got %v", what, err)
		}
		if took := time.Since(start); took < 20*time.Millisecond || took > 500*time.Millisecond {
			t.Errorf("%s: the held write took %v, want about the bound", what, took)
		}
	}
	notHeld := func(addr *net.UDPAddr, what string) {
		t.Helper()
		if _, err := c.WriteToAddrPort([]byte("x"), addr.AddrPort()); errors.Is(err, errStalled) || errors.Is(err, os.ErrDeadlineExceeded) {
			t.Fatalf("%s: the write must be tried and not hang, got %v", what, err)
		}
	}
	skipped := func(addr *net.UDPAddr, what string) {
		t.Helper()
		start := time.Now()
		if _, err := c.WriteTo([]byte("x"), addr); !errors.Is(err, errStalled) || time.Since(start) > 5*time.Millisecond {
			t.Fatalf("%s: the write must fail at once, got %v after %v", what, err, time.Since(start))
		}
	}
	// stalledFor checks addr is skipped for about d from now, and no longer.
	stalledFor := func(addr *net.UDPAddr, what string, d time.Duration) {
		t.Helper()
		skipped(addr, what)
		time.Sleep(d - 40*time.Millisecond)
		skipped(addr, what+", near the end of the stall")
		time.Sleep(60 * time.Millisecond)
	}

	// An address no write reached (from a loopback socket a write to an IPv6
	// address fails at once when not held).
	holding.Store("")
	notHeld(never, "not held")
	holding.Store(never.String())
	timedOut(never, "first timeout")
	notHeld(worked, "another address is not affected")
	stalledFor(never, "an address that never worked", maxStallSkip)
	timedOut(never, "the one try after the stall")
	stalledFor(never, "stalled again", maxStallSkip)
	if got := hn.held.Load(); got != 2 {
		t.Errorf("held writes: %d, want 2 (one try per stall; the skipped ones never reached the socket)", got)
	}

	// An address that worked (the write above went out), held for good.
	holding.Store(worked.String())
	timedOut(worked, "first")
	timedOut(worked, "second in a row")
	notHeld(never, "another address is not affected")
	stalledFor(worked, "first stall of an address that worked", stallSkip)
	timedOut(worked, "the try after the first stall")
	stalledFor(worked, "second stall", 2*stallSkip)
	timedOut(worked, "the try after the second stall")
	stalledFor(worked, "third stall, at the cap", maxStallSkip)
	// The hold lifts: the next try goes out, and it starts over.
	holding.Store("")
	notHeld(worked, "after the hold")
	holding.Store(worked.String())
	timedOut(worked, "held again")
	holding.Store("")
	notHeld(worked, "one timeout alone does not stall an address that worked")
	holding.Store(worked.String())
	timedOut(worked, "held again, after a write went out")
	timedOut(worked, "held again, second in a row")
	stalledFor(worked, "a stall after a write went out", stallSkip)
	if got := hn.held.Load(); got != 2+7 {
		t.Errorf("held writes: %d, want 9", got)
	}
}

// fdUDP models what Go does with one socket's writes, which holdUDP does not:
// they take the socket's write lock in turn, whatever their deadline, and a
// write waiting for the socket to become writable waits for the deadline set
// now, which a later SetWriteDeadline moves. Writes to an address hold picks
// wait for the socket to become writable, for good; the others go out.
type fdUDP struct {
	transport.UDPConn // a real socket, for all but the writes
	hold              func(net.Addr) bool

	fd       sync.Mutex // the socket's write lock: it ignores deadlines
	mu       sync.Mutex
	deadline time.Time
	moved    chan struct{} // closed when the deadline moves
}

func (c *fdUDP) SetWriteDeadline(d time.Time) error {
	c.mu.Lock()
	c.deadline = d
	close(c.moved)
	c.moved = make(chan struct{})
	c.mu.Unlock()
	return nil
}

func (c *fdUDP) WriteTo(b []byte, addr net.Addr) (int, error) {
	c.fd.Lock()
	defer c.fd.Unlock()
	for {
		c.mu.Lock()
		d, moved := c.deadline, c.moved
		c.mu.Unlock()
		if !d.IsZero() && !time.Now().Before(d) {
			return 0, os.ErrDeadlineExceeded
		}
		if !c.hold(addr) {
			return len(b), nil
		}
		var timeout <-chan time.Time
		if !d.IsZero() {
			tm := time.NewTimer(time.Until(d))
			defer tm.Stop()
			timeout = tm.C
		}
		select {
		case <-timeout:
		case <-moved:
		}
	}
}

// Several goroutines write to one socket (the ICE checks, DTLS, the media and
// its RTCP). A held write must still give up after its own bound, and the
// writes to an address that works must go out after it, not time out on a
// deadline the held one left behind, nor stall that address.
func TestBoundedUDPConcurrentWritersEachGetTheirOwnBound(t *testing.T) {
	const wait = 25 * time.Millisecond
	held := &net.UDPAddr{IP: net.ParseIP("2001:db8::1"), Port: 9}
	good := &net.UDPAddr{IP: net.IPv4(192, 0, 2, 7), Port: 9}
	real, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	defer real.Close()
	var holding atomic.Bool
	c := newBoundedUDP(&fdUDP{UDPConn: real, moved: make(chan struct{}),
		hold: func(a net.Addr) bool { return holding.Load() && a.String() == held.String() }}, wait)

	for round := 0; round < 3; round++ {
		// The held address worked until now, so a timeout alone does not
		// stall it, and each round's held write really waits.
		holding.Store(false)
		if _, err := c.WriteTo([]byte("x"), held); err != nil {
			t.Fatal(err)
		}
		holding.Store(true)
		heldTook := make(chan time.Duration, 1)
		go func() {
			start := time.Now()
			_, _ = c.WriteTo([]byte("x"), held)
			heldTook <- time.Since(start)
		}()
		var wg sync.WaitGroup
		errs := make(chan error, 6)
		for i := 0; i < 6; i++ {
			time.Sleep(5 * time.Millisecond)
			wg.Add(1)
			go func() {
				defer wg.Done()
				if _, err := c.WriteTo([]byte("x"), good); err != nil {
					errs <- err
				}
			}()
		}
		wg.Wait()
		close(errs)
		for err := range errs {
			t.Errorf("round %d: a write to the address that works failed: %v", round, err)
		}
		if took := <-heldTook; took < wait || took > 3*wait {
			t.Errorf("round %d: the held write took %v, want about its own bound of %v", round, took, wait)
		}
	}
	if _, err := c.WriteTo([]byte("x"), good); err != nil {
		t.Errorf("the address that works must not be stalled: %v", err)
	}
}

// The ICE agent's multicast DNS sockets must stay what pion's network layer
// made: golang.org/x/net joins them to the group through their file
// descriptor, which a wrapper hides, and without them the agent cannot
// resolve the sender's .local candidates.
func TestMulticastSocketsAreLeftAsTheyAre(t *testing.T) {
	n, err := netForPion()
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := n.(*boundedNet); !ok {
		t.Fatalf("the network is %T, want the bounded one", n)
	}
	for _, network := range []string{"udp4", "udp6"} {
		group := map[string]string{"udp4": "224.0.0.251:0", "udp6": "[ff02::fb]:0"}[network]
		laddr, err := net.ResolveUDPAddr(network, group)
		if err != nil {
			t.Fatal(err)
		}
		c, err := n.ListenUDP(network, laddr)
		if err != nil {
			t.Logf("%s: %v (no such socket here)", network, err)
			continue
		}
		if _, ok := c.(syscall.Conn); !ok {
			t.Errorf("%s: the multicast socket is a %T, which hides its file descriptor", network, c)
		}
		c.Close()
		p, err := n.ListenPacket(network, group)
		if err != nil {
			t.Fatal(err)
		}
		if _, ok := p.(syscall.Conn); !ok {
			t.Errorf("%s: the multicast packet socket is a %T, which hides its file descriptor", network, p)
		}
		p.Close()
	}
	c, err := n.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if _, ok := c.(*boundedUDP); !ok {
		t.Errorf("an ordinary socket is a %T, want its writes bounded", c)
	}
}

// An ICE agent on the receiver's network must start its multicast DNS: pion
// says when it cannot, and then drops every .local candidate of the sender.
func TestAgentOnTheBoundedNetworkHasMulticastDNS(t *testing.T) {
	n, err := netForPion()
	if err != nil {
		t.Fatal(err)
	}
	var logs strings.Builder
	var mu sync.Mutex
	lf := &logging.DefaultLoggerFactory{Writer: lockedWriter{&mu, &logs}, DefaultLogLevel: logging.LogLevelWarn}
	a, err := ice.NewAgentWithOptions(ice.WithNet(n), ice.WithLoggerFactory(lf),
		ice.WithMulticastDNSMode(ice.MulticastDNSModeQueryOnly))
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	mu.Lock()
	defer mu.Unlock()
	if strings.Contains(logs.String(), "mDNS") {
		t.Fatalf("the agent has no multicast DNS:\n%s", logs.String())
	}
}

type lockedWriter struct {
	mu *sync.Mutex
	w  *strings.Builder
}

func (l lockedWriter) Write(b []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.w.Write(b)
}

// Each connection must get its own network layer: pion's keeps the list of
// interfaces it saw when it was made, so a shared one would leave every later
// connection with the addresses the Mac had at the first.
func TestEachAnswerGetsItsOwnNetwork(t *testing.T) {
	var made atomic.Int64
	defer func(n func() (transport.Net, error)) { newNet = n }(newNet)
	newNet = func() (transport.Net, error) {
		made.Add(1)
		return stdnet.NewNet()
	}
	r := New(nil)
	r.SetICEServers(nil)
	defer r.Close()
	for i := 1; i <= 3; i++ {
		pc, _ := senderPeer(t, webrtc.RTPTransceiverDirectionSendrecv)
		if _, err := r.Answer(*pc.LocalDescription(), true); err != nil {
			t.Fatalf("answer %d: %v", i, err)
		}
		pc.Close()
		if got := made.Load(); got != int64(i) {
			t.Fatalf("after %d answers the network layer was made %d times, want once per answer", i, got)
		}
	}
}

// countNet counts the UDP sockets open on one network layer, which, now
// that each connection has its own, are that connection's; but for the
// multicast DNS ones, left as they are (see boundedNet.ListenUDP).
type countNet struct {
	transport.Net
	open atomic.Int64
}

type countUDP struct {
	transport.UDPConn
	n    *countNet
	once sync.Once
}

func (c *countUDP) Close() error {
	c.once.Do(func() { c.n.open.Add(-1) })
	return c.UDPConn.Close()
}

func (n *countNet) ListenUDP(network string, laddr *net.UDPAddr) (transport.UDPConn, error) {
	c, err := n.Net.ListenUDP(network, laddr)
	if err != nil || (laddr != nil && laddr.IP.IsMulticast()) {
		return c, err
	}
	n.open.Add(1)
	return &countUDP{UDPConn: c, n: n}, nil
}

func (n *countNet) ListenPacket(network, address string) (net.PacketConn, error) {
	c, err := n.Net.ListenPacket(network, address)
	if err != nil {
		return nil, err
	}
	if u, ok := c.(transport.UDPConn); ok {
		n.open.Add(1)
		return &countUDP{UDPConn: u, n: n}, nil
	}
	return c, nil
}

// A connection replaced by the next sender's closes in the background; its
// "closed" must not reach the status, where it came after the new
// connection's "connected" and said closed while the sender was connected.
func TestReplacedConnectionDoesNotReportItsClosing(t *testing.T) {
	var nets []*countNet
	defer func(n func() (transport.Net, error)) { newNet = n }(newNet)
	newNet = func() (transport.Net, error) {
		inner, err := stdnet.NewNet()
		if err != nil {
			return nil, err
		}
		n := &countNet{Net: inner}
		nets = append(nets, n) // Answer runs one at a time here
		return n, nil
	}
	var mu sync.Mutex
	var states []webrtc.PeerConnectionState
	connected := make(chan struct{}, 4)
	r := New(func(s webrtc.PeerConnectionState) {
		mu.Lock()
		states = append(states, s)
		mu.Unlock()
		if s == webrtc.PeerConnectionStateConnected {
			connected <- struct{}{}
		}
	})
	r.SetICEServers(nil)
	defer r.Close()
	connect := func(name string) *webrtc.PeerConnection {
		t.Helper()
		pc, _ := senderPeer(t, webrtc.RTPTransceiverDirectionSendrecv)
		answer, err := r.Answer(*pc.LocalDescription(), true)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if err := pc.SetRemoteDescription(*answer); err != nil {
			t.Fatal(err)
		}
		select {
		case <-connected:
		case <-time.After(15 * time.Second):
			t.Fatalf("%s did not connect", name)
		}
		return pc
	}
	first := connect("the first sender")
	defer first.Close()
	second := connect("the next sender")
	defer second.Close()
	// The first connection closes in the background, which takes a while:
	// wait until its sockets are closed, then for its last state change,
	// which pion reports right after.
	if len(nets) != 2 {
		t.Fatalf("%d network layers for 2 connections", len(nets))
	}
	for end := time.Now().Add(30 * time.Second); nets[0].open.Load() > 0; time.Sleep(50 * time.Millisecond) {
		if time.Now().After(end) {
			t.Fatalf("the replaced connection still has %d sockets open", nets[0].open.Load())
		}
	}
	time.Sleep(time.Second)
	mu.Lock()
	defer mu.Unlock()
	if last := states[len(states)-1]; last != webrtc.PeerConnectionStateConnected {
		t.Fatalf("the status says %v with the next sender connected (states: %v)", last, states)
	}
	for _, s := range states {
		if s == webrtc.PeerConnectionStateClosed || s == webrtc.PeerConnectionStateFailed {
			t.Fatalf("the replaced connection reported %v (states: %v)", s, states)
		}
	}
}

// With a TURN server the answer waits long enough for one TURN transaction
// on the agent's loop; without, the short wait stands.
func TestDescribeWaitCoversATURNTransaction(t *testing.T) {
	r := New(nil)
	if got := r.describeWait(); got != describeWait {
		t.Errorf("with STUN only: %v, want %v", got, describeWait)
	}
	r.SetICEServers([]webrtc.ICEServer{
		{URLs: []string{"stun:stun.example.org:3478"}},
		{URLs: []string{"turns:turn.example.org:5349?transport=tcp"}, Username: "u", Credential: "p"},
	})
	if got := r.describeWait(); got != turnDescribeWait {
		t.Errorf("with a TURN server: %v, want %v", got, turnDescribeWait)
	}
	if gatherWait+turnDescribeWait >= 15*time.Second {
		t.Errorf("gatherWait %v plus turnDescribeWait %v reach the 15 s the sender page waits for the answer",
			gatherWait, turnDescribeWait)
	}
}
