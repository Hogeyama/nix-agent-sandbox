// Offline container fixture for namespace and HTTP reachability probes.
#include <arpa/inet.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <signal.h>
#include <unistd.h>

int main(int argc, char **argv) {
  if (argc > 1 && strcmp(argv[1], "check-boundary") == 0) {
    if (mkdir("/tmp", 0755) != 0 && errno != EEXIST) return 6;
    if (mkdir("/tmp/probe-mount", 0755) != 0) return 7;
    if (mount("tmpfs", "/tmp/probe-mount", "tmpfs", 0, NULL) != 0) return 8;
    if (umount("/tmp/probe-mount") != 0) return 9;
    char text[32] = {0};
    FILE *f = fopen("/outside/fixture/secret.txt", "r");
    if (!f || !fgets(text, sizeof(text), f)) return 10;
    fclose(f);
    if (strcmp(text, "masked\n") != 0) return 11;
    if (access("/outside/home", F_OK) == 0) return 12;
    if (access("/outside/run/docker.sock", F_OK) == 0) return 13;
    if (umount("/outside/fixture/secret.txt") == 0) return 14;
    int unmount_error = errno;
    if (unmount_error != EINVAL && unmount_error != EPERM) return 16;
    if (mount(NULL, "/outside/fixture", NULL, MS_REMOUNT | MS_BIND, NULL) == 0) return 15;
    int remount_error = errno;
    if (remount_error != EPERM && remount_error != EACCES) return 17;
    printf("PASS privileged fixture: new mount works; protected unmount/remount denied (%d/%d)\n", unmount_error, remount_error);
    return 0;
  }
  if (argc > 1 && strcmp(argv[1], "hello") == 0) {
    printf("fixture uid=%d gid=%d\n", (int)getuid(), (int)getgid());
    return 0;
  }
  signal(SIGPIPE, SIG_IGN);
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  int one = 1;
  if (fd < 0 || setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one)) < 0) return 20;
  struct sockaddr_in addr = {.sin_family = AF_INET, .sin_port = htons(8080), .sin_addr.s_addr = htonl(INADDR_ANY)};
  if (bind(fd, (struct sockaddr *)&addr, sizeof(addr)) < 0 || listen(fd, 16) < 0) {
    perror("fixture listen");
    return 21;
  }
  puts("fixture ready");
  fflush(stdout);
  for (;;) {
    int client = accept(fd, NULL, NULL);
    if (client < 0) { if (errno == EINTR) continue; return 22; }
    char request[4096];
    if (read(client, request, sizeof(request)) > 0) {
      const char response[] = "HTTP/1.1 200 OK\r\nContent-Length: 9\r\nConnection: close\r\n\r\nprobe-ok\n";
      (void)write(client, response, sizeof(response)-1);
    }
    close(client);
  }
}
