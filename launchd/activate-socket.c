#include <fcntl.h>
#include <launch.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

int main(int argc, char **argv) {
    int *sockets = NULL;
    size_t count = 0;
    if (argc < 2 || launch_activate_socket("ASCListener", &sockets, &count) != 0 ||
        count != 1) {
        fputs("ASC socket activation failed.\n", stderr);
        free(sockets);
        return EXIT_FAILURE;
    }

    int listener = sockets[0];
    free(sockets);
    // A launch during registration can precede an actual client. Wait for
    // a queued connection before starting the credential provider.
    struct pollfd ready = { .fd = listener, .events = POLLIN };
    int result = poll(&ready, 1, 1000);
    if (result == 0) return EXIT_SUCCESS;
    if (result < 0 || !(ready.revents & POLLIN)) {
        fputs("ASC socket readiness check failed.\n", stderr);
        return EXIT_FAILURE;
    }

    // The credential launcher preserves stdin for its child. Use that
    // descriptor to pass the listener through to Node.
    if (dup2(listener, STDIN_FILENO) == -1 ||
        fcntl(STDIN_FILENO, F_SETFD, 0) == -1) {
        fputs("ASC socket descriptor setup failed.\n", stderr);
        return EXIT_FAILURE;
    }
    if (listener != STDIN_FILENO) close(listener);
    execv(argv[1], &argv[1]);
    fputs("ASC daemon launcher failed.\n", stderr);
    return EXIT_FAILURE;
}
