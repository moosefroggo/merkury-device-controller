"""mitmproxy addon — captures headers and responses from pepperos.io."""
import json

def request(flow):
    if "pepperos.io" in flow.request.pretty_host:
        print(f"\n>>> {flow.request.method} {flow.request.pretty_url}")
        for k, v in flow.request.headers.items():
            print(f"    {k}: {v}")
        if flow.request.content:
            try:
                print(f"    BODY: {flow.request.text}")
            except Exception:
                pass
        print()

def response(flow):
    if "pepperos.io" in flow.request.pretty_host and "byToken" in flow.request.pretty_url:
        print(f"\n<<< RESPONSE {flow.request.pretty_url}")
        print(f"    Status: {flow.response.status_code}")
        try:
            print(f"    BODY: {flow.response.text}")
        except Exception:
            pass
        print()
