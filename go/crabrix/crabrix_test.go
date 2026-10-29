package crabrix

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestRealBundledMCP(t *testing.T) {
	c, err := New(context.Background(), Options{})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	data, err := c.Status(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	var status struct{ Connected bool }
	if err = json.Unmarshal(data, &status); err != nil || status.Connected {
		t.Fatal("expected disconnected status")
	}
	if _, err = c.Call(context.Background(), "shell", nil); err == nil {
		t.Fatal("unknown tool accepted")
	}
	_, err = c.Connect(context.Background(), "https://example.com/#private-never-return")
	if err == nil || strings.Contains(err.Error(), "private-never-return") {
		t.Fatal("unsafe URL or error")
	}
	c.Close()
	if _, err = c.Status(context.Background()); err == nil {
		t.Fatal("closed client accepted")
	}
}
func TestRedactedHandoff(t *testing.T) {
	h := Handoff{Link: "private-key", Mode: "edit"}
	for _, v := range []string{fmt.Sprint(h), fmt.Sprintf("%+v", h), fmt.Sprintf("%#v", h)} {
		if strings.Contains(v, "private-key") {
			t.Fatal("link leaked in fmt")
		}
	}
}
func TestFlagLikeParticipantNames(t *testing.T) {
	for _, name := range []string{"--help", "--version"} {
		c, err := New(context.Background(), Options{Name: name})
		if err != nil {
			t.Fatal(err)
		}
		_, err = c.Status(context.Background())
		c.Close()
		if err != nil {
			t.Fatal(err)
		}
	}
}
func TestOptions(t *testing.T) {
	if _, err := New(context.Background(), Options{Timeout: -time.Second}); err == nil {
		t.Fatal("negative timeout accepted")
	}
	if _, err := New(nil, Options{}); err == nil {
		t.Fatal("nil context accepted")
	}
}
