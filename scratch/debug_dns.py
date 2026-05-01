import socket
import sys

def check_dns(hostname):
    try:
        print(f"Resolving {hostname}...")
        results = socket.getaddrinfo(hostname, 5001)
        for res in results:
            print(f"Family: {res[0]}, Type: {res[1]}, Proto: {res[2]}, Canonname: {res[3]}, Sockaddr: {res[4]}")
    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    check_dns("mediaonenas.sg3.quickconnect.to")
