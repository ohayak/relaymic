package rtc

import (
	"errors"
	"net"
	"net/netip"
	"os"
	"sync"
	"time"

	"github.com/pion/transport/v4"
	"github.com/pion/transport/v4/stdnet"
)

// udpWriteWait bounds every UDP write of the sender's connection. A UDP write
// takes microseconds, or fails at once; it only waits when something below
// the socket holds its packets. On a managed Mac that happened for real: a
// VPN tunnel or a network filter never took the connectivity checks to one of
// the sender's IPv6 addresses, the write waited for good, and since pion's ICE
// agent sends its checks from its one task loop, the whole agent stopped. The
// answer then never came (it needs the agent for the local candidates), and
// the next answers waited behind the stuck connection. Bounded, a held write
// fails like a lost packet: the check is retried, the other address pairs go
// on, and a held media packet is dropped instead of stalling the sender.
// A variable, so a test can change it; 0 leaves the writes unbounded.
var udpWriteWait = 25 * time.Millisecond

// stallSkip applies to an address the socket's writes did reach before: once
// its last two writes timed out, the writes to it fail at once for stallSkip,
// before one more bounded try. A filter that holds the working address for a
// moment then costs the sound a fraction of a second, not seconds. Each stall in a row
// doubles it, up to maxStallSkip, and a write that goes out starts it over.
// Two timeouts in a row, not one: a write that is merely slow once on a busy
// Mac costs that one packet.
var stallSkip = 200 * time.Millisecond

// maxStallSkip is the longest a stall lasts, and how long one lasts at once
// for an address no write from the socket ever reached, which a single
// timeout stalls: there is nothing to lose there. The ICE agent checks every
// address pair several times a second from its one loop: without the stall,
// each held destination would cost it udpWriteWait on every round, and with a
// whole address family held (IPv6 through a tunnel, say) the rounds grow so
// slow that the pairs that work do not get through. Gathering waits for the
// same loop, so each timeout also delays the answer.
var maxStallSkip = 2 * time.Second

// errStalled is a write skipped because the last one to its address timed
// out; to pion it is one more lost packet.
var errStalled = errors.New("the last write to this address did not go out; skipping it for now")

// newNet is pion's own network layer, which boundedNet wraps; a test swaps in
// one whose writes it holds. It is called once per connection: pion's network
// layer keeps the list of network interfaces it saw when it was made, so a
// connection must get its own to see the Mac's addresses as they are now,
// after a Wi-Fi change, a VPN tunnel coming up or a wake from sleep.
var newNet = func() (transport.Net, error) { return stdnet.NewNet() }

// boundedNet is pion's network layer with a deadline on every write of the
// UDP sockets it opens, but for the multicast DNS ones (see ListenUDP).
type boundedNet struct {
	transport.Net
	wait time.Duration
}

// netForPion is what the receiver's connections use: the network layer, with
// its UDP writes bounded unless udpWriteWait is 0.
func netForPion() (transport.Net, error) {
	n, err := newNet()
	if err != nil || udpWriteWait <= 0 {
		return n, err
	}
	return &boundedNet{Net: n, wait: udpWriteWait}, nil
}

func (n *boundedNet) ListenPacket(network, address string) (net.PacketConn, error) {
	c, err := n.Net.ListenPacket(network, address)
	if err != nil {
		return nil, err
	}
	if a, err := netip.ParseAddrPort(address); err == nil && a.Addr().IsMulticast() {
		return c, nil
	}
	if u, ok := c.(transport.UDPConn); ok {
		return newBoundedUDP(u, n.wait), nil
	}
	return c, nil
}

// ListenUDP leaves a socket on a multicast address as it is: those are the
// ICE agent's multicast DNS sockets, which it joins to the group through the
// socket's file descriptor (golang.org/x/net/ipv4 needs a syscall.Conn), and
// which it writes to from the mDNS server's own goroutines, never from its
// task loop. Wrapped, they could not join, and the agent would run without
// mDNS: it could not resolve the sender's .local candidates, which a browser
// offers until the page is allowed the microphone or the camera.
func (n *boundedNet) ListenUDP(network string, laddr *net.UDPAddr) (transport.UDPConn, error) {
	c, err := n.Net.ListenUDP(network, laddr)
	if err != nil {
		return nil, err
	}
	if laddr != nil && laddr.IP.IsMulticast() {
		return c, nil
	}
	return newBoundedUDP(c, n.wait), nil
}

func (n *boundedNet) DialUDP(network string, laddr, raddr *net.UDPAddr) (transport.UDPConn, error) {
	c, err := n.Net.DialUDP(network, laddr, raddr)
	if err != nil {
		return nil, err
	}
	return newBoundedUDP(c, n.wait), nil
}

// boundedUDP is a UDP socket whose every write gives up after wait, and
// whose writes to an address that timed out twice in a row fail at once for
// a while (see stallSkip and maxStallSkip).
//
// Its writes run one at a time, each under a deadline set when its turn
// comes. Go runs a socket's writes one at a time anyway, and a socket has one
// write deadline: unserialized, each writer would move it for the write
// already waiting, so a held write would wait as long as others kept coming,
// and the writes queued behind it would find the deadline past and time out
// without having been tried, charged to an address that works. Several
// goroutines do write to one socket (the ICE checks, DTLS, the media and its
// RTCP), so a write may wait for the ones before it, each bounded.
type boundedUDP struct {
	transport.UDPConn
	wait time.Duration

	mu   sync.Mutex // held for the whole of each write
	held map[netip.Addr]*heldAddr
}

// heldAddr is what a socket knows of an address it writes to.
type heldAddr struct {
	worked   bool          // a write to it went out
	timeouts int           // timed-out writes in a row
	skip     time.Duration // the last stall's length; the next is twice that
	until    time.Time     // writes are skipped until then
}

func newBoundedUDP(c transport.UDPConn, wait time.Duration) *boundedUDP {
	return &boundedUDP{UDPConn: c, wait: wait, held: map[netip.Addr]*heldAddr{}}
}

// write runs one write to addr (invalid for a connected socket's Write):
// skipped while addr is stalled, else bounded. Every timeout from the second
// in a row on (from the first, for an address no write reached) stalls addr,
// so after a stall one more timeout stalls it again; any write that does not
// hang clears the count.
func (c *boundedUDP) write(addr netip.Addr, do func() (int, error)) (int, error) {
	addr = addr.Unmap()
	c.mu.Lock()
	defer c.mu.Unlock()
	h := c.held[addr]
	if h != nil && time.Now().Before(h.until) {
		return 0, errStalled
	}
	c.bound()
	n, err := do()
	if !addr.IsValid() {
		return n, err
	}
	if h == nil {
		h = &heldAddr{}
		c.held[addr] = h
	}
	if !errors.Is(err, os.ErrDeadlineExceeded) {
		// It went out, or failed at once: either way nothing holds this address.
		h.worked = h.worked || err == nil
		h.timeouts, h.skip = 0, 0
		return n, err
	}
	h.timeouts++
	if h.timeouts >= 2 || !h.worked {
		switch {
		case h.skip > 0:
			h.skip = min(2*h.skip, maxStallSkip)
		case h.worked:
			h.skip = min(stallSkip, maxStallSkip)
		default:
			h.skip = maxStallSkip
		}
		h.until = time.Now().Add(h.skip)
	}
	return n, err
}

func udpAddrOf(a net.Addr) netip.Addr {
	if u, ok := a.(*net.UDPAddr); ok && u != nil {
		return u.AddrPort().Addr()
	}
	return netip.Addr{}
}

// addrPortConn is what *net.UDPConn offers beyond transport.UDPConn, and
// what pion's ICE uses when a socket has it.
type addrPortConn interface {
	ReadFromUDPAddrPort(b []byte) (int, netip.AddrPort, error)
	WriteToUDPAddrPort(b []byte, addr netip.AddrPort) (int, error)
}

func (c *boundedUDP) bound() { _ = c.UDPConn.SetWriteDeadline(time.Now().Add(c.wait)) }

func (c *boundedUDP) Write(b []byte) (int, error) {
	return c.write(netip.Addr{}, func() (int, error) { return c.UDPConn.Write(b) })
}

func (c *boundedUDP) WriteTo(b []byte, addr net.Addr) (int, error) {
	return c.write(udpAddrOf(addr), func() (int, error) { return c.UDPConn.WriteTo(b, addr) })
}

func (c *boundedUDP) WriteToUDP(b []byte, addr *net.UDPAddr) (int, error) {
	return c.write(udpAddrOf(addr), func() (int, error) { return c.UDPConn.WriteToUDP(b, addr) })
}

func (c *boundedUDP) WriteMsgUDP(b, oob []byte, addr *net.UDPAddr) (int, int, error) {
	var oobn int
	n, err := c.write(udpAddrOf(addr), func() (int, error) {
		n, o, err := c.UDPConn.WriteMsgUDP(b, oob, addr)
		oobn = o
		return n, err
	})
	return n, oobn, err
}

// ReadFromAddrPort and WriteToAddrPort make the socket pion's
// AddrPortReaderWriter, its allocation-free path, which it otherwise takes
// only for a bare *net.UDPConn.
func (c *boundedUDP) ReadFromAddrPort(b []byte) (int, netip.AddrPort, error) {
	if a, ok := c.UDPConn.(addrPortConn); ok {
		return a.ReadFromUDPAddrPort(b)
	}
	n, addr, err := c.UDPConn.ReadFrom(b)
	if err != nil {
		return n, netip.AddrPort{}, err
	}
	u, _ := addr.(*net.UDPAddr)
	if u == nil {
		return n, netip.AddrPort{}, nil
	}
	return n, u.AddrPort(), nil
}

func (c *boundedUDP) WriteToAddrPort(b []byte, addr netip.AddrPort) (int, error) {
	return c.write(addr.Addr(), func() (int, error) {
		if a, ok := c.UDPConn.(addrPortConn); ok {
			return a.WriteToUDPAddrPort(b, addr)
		}
		return c.UDPConn.WriteTo(b, net.UDPAddrFromAddrPort(addr))
	})
}
