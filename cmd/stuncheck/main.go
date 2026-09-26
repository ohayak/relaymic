// stuncheck determines the NAT type of the local network and lists the usable
// STUN servers.
//
// This is the basis for deciding whether to run your own TURN:
//   - cone NAT: UDP hole punching mostly works, no relay server needed
//   - symmetric NAT: the external port changes per destination, hole punching
//     is nearly hopeless, TURN is required
//
// The method is to query several STUN servers from the same local socket and
// compare the external ports they see. Querying from different sockets cannot
// tell: the ports would differ anyway.
package main

import (
	"flag"
	"fmt"
	"net"
	"time"

	"github.com/pion/stun/v3"
)

var defaultServers = []string{
	"stun.l.google.com:19302",
	"stun.cloudflare.com:3478",
	"stun.nextcloud.com:3478",
	"stun.miwifi.com:3478",
	"stun.chat.bilibili.com:3478",
}

func main() {
	timeout := flag.Duration("timeout", 4*time.Second, "timeout per server")
	flag.Parse()

	servers := flag.Args()
	if len(servers) == 0 {
		servers = defaultServers
	}

	conn, err := net.ListenPacket("udp4", ":0")
	if err != nil {
		fmt.Println("create socket failed:", err)
		return
	}
	defer conn.Close()
	fmt.Printf("local port: %s\n\n", conn.LocalAddr())

	fmt.Printf("%-32s %-24s %s\n", "STUN server", "external address seen", "time")
	var mapped []string
	for _, s := range servers {
		start := time.Now()
		addr, err := probe(conn, s, *timeout)
		if err != nil {
			fmt.Printf("%-32s %-24s %v\n", s, "x unreachable", err)
			continue
		}
		fmt.Printf("%-32s %-24s %v\n", s, addr, time.Since(start).Round(time.Millisecond))
		mapped = append(mapped, addr)
	}

	fmt.Println()
	switch {
	case len(mapped) < 2:
		fmt.Println("Verdict: fewer than 2 reachable STUN servers, cannot determine NAT type")
	case allSame(mapped):
		fmt.Println("Verdict: cone NAT - every STUN server sees the same local port mapped to the same external port")
		fmt.Println("         UDP NAT traversal will usually succeed; no need to run your own TURN")
	default:
		fmt.Println("Verdict: symmetric NAT - the external port changes with the destination")
		fmt.Println("         NAT traversal rarely succeeds; a TURN relay is required across networks")
	}
}

func allSame(addrs []string) bool {
	for _, a := range addrs[1:] {
		if a != addrs[0] {
			return false
		}
	}
	return true
}

func probe(conn net.PacketConn, server string, timeout time.Duration) (string, error) {
	raddr, err := net.ResolveUDPAddr("udp4", server)
	if err != nil {
		return "", err
	}
	if _, err := conn.WriteTo(stun.MustBuild(stun.TransactionID, stun.BindingRequest).Raw, raddr); err != nil {
		return "", err
	}
	_ = conn.SetReadDeadline(time.Now().Add(timeout))

	buf := make([]byte, 1500)
	for {
		n, from, err := conn.ReadFrom(buf)
		if err != nil {
			return "", err
		}
		// Concurrent responses may interleave; only accept packets from the server being queried.
		if from.String() != raddr.String() {
			continue
		}
		msg := &stun.Message{Raw: append([]byte{}, buf[:n]...)}
		if err := msg.Decode(); err != nil {
			return "", err
		}
		var xor stun.XORMappedAddress
		if err := xor.GetFrom(msg); err != nil {
			return "", err
		}
		return fmt.Sprintf("%s:%d", xor.IP, xor.Port), nil
	}
}
