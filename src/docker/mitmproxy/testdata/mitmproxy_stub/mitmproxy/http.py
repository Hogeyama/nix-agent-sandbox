class HTTPFlow:
    pass


class Response:
    """Minimal stand-in for mitmproxy.http.Response.

    Real signature: Response.make(status_code=200, content=b"", headers=None).
    Only the bits nas_addon.py and its tests rely on (status_code) are kept.
    """

    def __init__(self, status_code=200, content=b"", headers=None):
        self.status_code = status_code
        self.content = content
        self.headers = headers or {}

    @staticmethod
    def make(status_code=200, content=b"", headers=None):
        return Response(status_code, content, headers)
