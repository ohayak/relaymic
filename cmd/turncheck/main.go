// turncheck requests one relay allocation from a TURN server and verifies that
// the relay address can really send and receive data.
//
// STUN working does not mean TURN works: the allocation request goes over 3478,
// but the actual relaying uses a separate port range, and if that range is not
// opened ICE gets a relay candidate that never connects.
package main

import (
	"flag"
	"fmt"
	"net"
	"os"
	"time"

	"github.com/pion/turn/v5"
)

func main() {
	server := flag.String("server", "", "TURN server host:port")
	user := flag.String("user", "", "username")
	pass := flag.String("pass", "", "password")
	realm := flag.String("realm", "", "realm")
	flag.Parse()

	if *server == "" || *user == "" {
		fmt.Fprintln(os.Stderr, "usage: turncheck -server host:3478 -user U -pass P -realm R")
		os.Exit(2)
	}

	conn, err := net.ListenPacket("udp4", "0.0.0.0:0")
	if err != nil {
		die("create local socket", err)
	}
	defer conn.Close()

	client, err := turn.NewClient(&turn.ClientConfig{
		STUNServerAddr: *server,
		TURNServerAddr: *server,
		Conn:           conn,
		Username:       *user,
		Password:       *pass,
		Realm:          *realm,
	})
	if err != nil {
		die("create TURN client", err)
	}
	defer client.Close()

	if err := client.Listen(); err != nil {
		die("start listening", err)
	}

	start := time.Now()
	mapped, err := client.SendBindingRequest()
	if err != nil {
		die("STUN binding request", err)
	}
	fmt.Printf("STUN binding    OK  external address seen %s  (%v)\n", mapped, time.Since(start).Round(time.Millisecond))

	start = time.Now()
	relay, err := client.Allocate()
	if err != nil {
		die("TURN allocation (auth failed or relay port range not open)", err)
	}
	defer relay.Close()
	fmt.Printf("TURN allocation OK  relay address %s  (%v)\n", relay.LocalAddr(), time.Since(start).Round(time.Millisecond))

	// The real test: request a second relay and have the two relays exchange data.
	// Both ends are the server's public address, so the denied-peer-ip rule does not
	// block them; using a local private address as the peer proves nothing, since
	// blocking it is the configuration working correctly.
	peerConn, err := net.ListenPacket("udp4", "0.0.0.0:0")
	if err != nil {
		die("create second socket", err)
	}
	defer peerConn.Close()

	peerClient, err := turn.NewClient(&turn.ClientConfig{
		STUNServerAddr: *server,
		TURNServerAddr: *server,
		Conn:           peerConn,
		Username:       *user,
		Password:       *pass,
		Realm:          *realm,
	})
	if err != nil {
		die("create second TURN client", err)
	}
	defer peerClient.Close()
	if err := peerClient.Listen(); err != nil {
		die("second client listen", err)
	}
	peerRelay, err := peerClient.Allocate()
	if err != nil {
		die("second TURN allocation", err)
	}
	defer peerRelay.Close()
	fmt.Printf("second relay    OK  %s\n", peerRelay.LocalAddr())

	payload := []byte("remotevisio-turn-probe")
	start = time.Now()
	if _, err := peerRelay.WriteTo(payload, relay.LocalAddr()); err != nil {
		die("send through relay", err)
	}

	buf := make([]byte, 1500)
	_ = relay.SetReadDeadline(time.Now().Add(6 * time.Second))
	n, from, err := relay.ReadFrom(buf)
	if err != nil {
		fmt.Printf("relay forward   FAILED  allocation succeeded but no data got through: %v\n", err)
		os.Exit(1)
	}
	if string(buf[:n]) != string(payload) {
		fmt.Printf("relay forward   FAILED  received data does not match\n")
		os.Exit(1)
	}
	fmt.Printf("relay forward   OK  %d bytes delivered intact from %s  (%v)\n",
		n, from, time.Since(start).Round(time.Millisecond))
	fmt.Println("\nVerdict: TURN is fully usable; audio can be relayed through it")
}

func die(what string, err error) {
	fmt.Fprintf(os.Stderr, "%s failed: %v\n", what, err)
	os.Exit(1)
}
